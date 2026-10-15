use std::sync::{Arc, Mutex};

use bytes::Bytes;
use moq_mux::catalog::hang::Container;
use moq_mux::container::{Frame, FrameContext, FrameTransform, Kind, Producer};
use moq_net::Timestamp;

#[derive(Clone, Default)]
struct SealSpy(Arc<Mutex<Vec<(String, u64, u64)>>>);

impl FrameTransform for SealSpy {
	fn transform(&self, ctx: FrameContext<'_>, payload: Bytes) -> Bytes {
		self.0
			.lock()
			.unwrap()
			.push((ctx.track.to_string(), ctx.group, ctx.object));
		let mut sealed = vec![0x53];
		sealed.extend_from_slice(&payload);
		Bytes::from(sealed)
	}
}

fn track(name: &str) -> moq_net::track::Producer {
	moq_net::broadcast::Info::new()
		.produce()
		.create_track(name, hang::container::track_info(hang::catalog::PRIORITY.video))
		.unwrap()
}

fn replay() -> moq_net::track::Subscription {
	moq_net::track::Subscription::default().with_max_delay(std::time::Duration::from_secs(30))
}

fn frame(timestamp_us: u64, keyframe: bool) -> Frame {
	Frame {
		timestamp: Timestamp::from_micros(timestamp_us).unwrap(),
		payload: Bytes::from_static(&[0xDE, 0xAD]),
		keyframe,
		duration: None,
	}
}

async fn payloads(mut consumer: moq_net::track::Subscriber) -> Vec<Bytes> {
	let mut out = Vec::new();
	while let Some(mut group) = consumer.recv_group().await.unwrap() {
		while let Some(mut frame) = group.next_frame().await.unwrap() {
			out.push(frame.read_all().await.unwrap());
		}
	}
	out
}

#[tokio::test]
async fn the_transform_sees_each_frames_track_group_and_object() {
	let track = track("cam");
	let consumer = track.subscribe(replay());
	let spy = SealSpy::default();
	let mut producer = Producer::new(track, Container::Legacy(Kind::Data)).with_transform(Arc::new(spy.clone()));

	producer.write(frame(0, true)).unwrap();
	producer.write(frame(10_000, false)).unwrap();
	producer.write(frame(20_000, true)).unwrap();
	producer.write(frame(30_000, false)).unwrap();
	producer.finish().unwrap();

	assert_eq!(
		*spy.0.lock().unwrap(),
		vec![
			("cam".to_string(), 0, 0),
			("cam".to_string(), 0, 1),
			("cam".to_string(), 1, 0),
			("cam".to_string(), 1, 1),
		]
	);
	let written = payloads(consumer).await;
	assert!(!written.is_empty());
	for payload in written.iter().filter(|payload| !payload.is_empty()) {
		assert!(payload.ends_with(&[0x53, 0xDE, 0xAD]), "{payload:?}");
	}
}

#[tokio::test]
async fn without_a_transform_payloads_stay_in_the_clear() {
	let track = track("cam");
	let consumer = track.subscribe(replay());
	let mut producer = Producer::new(track, Container::Legacy(Kind::Data));

	producer.write(frame(0, true)).unwrap();
	producer.finish().unwrap();

	let written = payloads(consumer).await;
	assert!(written.iter().any(|payload| payload.ends_with(&[0xDE, 0xAD])));
	assert!(!written.iter().any(|payload| payload.ends_with(&[0x53, 0xDE, 0xAD])));
}
