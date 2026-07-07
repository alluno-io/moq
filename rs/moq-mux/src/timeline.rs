//! Timeline publish/subscribe.
//!
//! A timeline is one media track's group index: one [`hang::timeline::Record`] per group,
//! appended the moment the group opens, mapping a group sequence to the group's start
//! timestamp. A consumer can answer "which group covers time T" and "where is the live edge"
//! from a few bytes per group without subscribing to media, the primitive a playlist server
//! (HLS/DASH), a seek bar, or a recorder index needs.
//!
//! One timeline track per media track (audio and video groups have different durations, so a
//! single broadcast-wide timeline can't describe both). The [`catalog::Producer`] creates and
//! owns one [`Producer`] per rendition, exposed via
//! [`catalog::Producer::timeline`](crate::catalog::Producer::timeline); the rendition's
//! catalog entry advertises it via a [`hang::catalog::Timeline`] section (see
//! [`Producer::section`]), and the media track's
//! [`container::Producer`](crate::container::Producer) records each group open when built with a
//! [`ProducerConfig`](crate::container::ProducerConfig) carrying this producer. Like any track, it
//! costs nothing until someone subscribes.
//!
//! On the wire the track is a DEFLATE-compressed [`moq_json::stream`] (a single group, one
//! record per frame; see [`hang::timeline`] for the record schema).
//!
//! [`record`](Producer::record) is throttled to a [`granularity`](Producer::with_granularity)
//! (default [`DEFAULT_GRANULARITY`], one second): at most one record per that much media time.
//! Video keyframes are already a granularity or more apart, so every group is indexed; short
//! audio groups are thinned out. A consumer that lands between two records extrapolates the group
//! number (sequences are contiguous) or fetches to fill the gap.

use std::sync::{Arc, Mutex};

use hang::catalog::Timeline;
use hang::timeline::{Record, track_name};

use crate::container::Timestamp;

/// The default [`granularity`](Producer::with_granularity): at most one record per second of
/// media time.
pub const DEFAULT_GRANULARITY: Timestamp = Timestamp::from_secs_unchecked(1);

/// Publishes one media track's timeline.
///
/// Cheaply clonable: clones share the single underlying track and throttle state, so the catalog
/// section, the media track's group recorder, and any consumers all reference one log.
#[derive(Clone)]
pub struct Producer {
	inner: moq_json::stream::Producer<Record>,
	track: String,
	timescale: u32,
	// The wall-clock time of pts 0 (in timescale units, Unix epoch) advertised in the catalog
	// section, shared across clones.
	wall: Arc<Mutex<Option<u64>>>,
	// Minimum media-time gap between recorded groups (throttle).
	granularity: Timestamp,
	// The pts of the last recorded group, shared across clones so the throttle is coordinated.
	last: Arc<Mutex<Option<Timestamp>>>,
}

impl Producer {
	/// Create a timeline track for the media rendition `name` on the given broadcast.
	///
	/// The track is named per [`hang::timeline::track_name`] (`<name>.timeline`) at the
	/// default millisecond timescale and [`DEFAULT_GRANULARITY`].
	pub fn new(broadcast: &mut moq_net::BroadcastProducer, name: &str) -> Result<Self, moq_net::Error> {
		let track = track_name(name);
		let net = broadcast.create_track(moq_net::Track::new(&track))?;

		let mut config = moq_json::stream::ProducerConfig::default();
		config.compression = true;

		Ok(Self {
			inner: moq_json::stream::Producer::new(net, config),
			track,
			timescale: Timeline::default_timescale(),
			wall: Arc::new(Mutex::new(None)),
			granularity: DEFAULT_GRANULARITY,
			last: Arc::new(Mutex::new(None)),
		})
	}

	/// Set the record throttle: at most one record per `granularity` of media time. See
	/// [`DEFAULT_GRANULARITY`].
	pub fn with_granularity(mut self, granularity: Timestamp) -> Self {
		self.granularity = granularity;
		self
	}

	/// The catalog section advertising this timeline, to attach to the rendition's config.
	pub fn section(&self) -> Timeline {
		let mut section = Timeline::new(&self.track);
		section.timescale = self.timescale;
		section.wall = *self.wall.lock().unwrap();
		section
	}

	/// Set (or replace) the wall-clock anchor advertised in the catalog section, from an observed
	/// pairing of a media timestamp `pts` with its wall-clock time `unix_millis` (Unix epoch
	/// milliseconds).
	///
	/// Stored as the extrapolated wall-clock time of pts 0, the single value the
	/// [`Timeline::wall`](hang::catalog::Timeline::wall) field carries: in this timeline's
	/// timescale, measured from the moq epoch ([`MOQ_EPOCH_UNIX_MILLIS`](hang::catalog::MOQ_EPOCH_UNIX_MILLIS),
	/// 2020). Re-read every time the rendition republishes its catalog entry, so set it before
	/// (or as) the rendition registers.
	pub fn set_wall(&self, pts: Timestamp, unix_millis: u64) {
		let scale = self.timescale as u128;
		let pts_units = pts.as_scale(self.timescale as u64);
		let moq_millis = unix_millis.saturating_sub(hang::catalog::MOQ_EPOCH_UNIX_MILLIS);
		let moq_units = moq_millis as u128 * scale / 1000;
		*self.wall.lock().unwrap() = Some(moq_units.saturating_sub(pts_units) as u64);
	}

	/// Record that group `sequence` opened at presentation time `pts`, unless it falls within the
	/// [`granularity`](Self::with_granularity) of the last recorded group (in which case it's
	/// skipped and a consumer extrapolates or fetches to fill the gap).
	pub fn record(&mut self, sequence: u64, pts: Timestamp) -> Result<(), moq_net::Error> {
		{
			let mut last = self.last.lock().unwrap();
			if let Some(last) = *last
				&& pts.as_micros() < last.as_micros() + self.granularity.as_micros()
			{
				return Ok(());
			}
			*last = Some(pts);
		}

		let record = Record::new(sequence, pts.as_scale(self.timescale as u64) as u64);
		match self.inner.append(&record) {
			Ok(()) => Ok(()),
			Err(moq_json::Error::Net(err)) => Err(err),
			// A record is plain integers, and the DEFLATE encoder is infallible, so only a
			// transport error can surface.
			Err(err) => unreachable!("timeline record failed to encode: {err}"),
		}
	}

	/// Create a subscriber for the underlying track.
	pub fn consume(&self) -> Consumer {
		Consumer::new(self.inner.consume(), self.timescale)
	}

	/// Finish the timeline track, closing any open group.
	pub fn finish(&mut self) -> Result<(), moq_net::Error> {
		match self.inner.finish() {
			Ok(()) => Ok(()),
			Err(moq_json::Error::Net(err)) => Err(err),
			Err(err) => unreachable!("timeline finish failed to encode: {err}"),
		}
	}
}

/// Consumes a timeline track, yielding every [`Record`] in publish order.
pub struct Consumer {
	inner: moq_json::stream::Consumer<Record>,
	timescale: u32,
}

impl Consumer {
	/// Create a consumer reading from the given track subscriber.
	///
	/// `timescale` is the media track's [`Timeline::timescale`], read from its catalog
	/// section, so [`pts_micros`](Self::pts_micros) can convert records back to microseconds.
	pub fn new(track: moq_net::TrackConsumer, timescale: u32) -> Self {
		let mut config = moq_json::stream::ConsumerConfig::default();
		config.compression = true;

		Self {
			inner: moq_json::stream::Consumer::new(track, config),
			timescale,
		}
	}

	/// The timescale (units per second) of the records' `pts` field.
	pub fn timescale(&self) -> u32 {
		self.timescale
	}

	/// Convert a record's `pts` (in this timeline's timescale) to microseconds.
	pub fn pts_micros(&self, pts: u64) -> u64 {
		(pts as u128 * 1_000_000 / self.timescale as u128) as u64
	}

	/// Get the next record, or `None` once the track ends.
	pub async fn next(&mut self) -> Result<Option<Record>, moq_json::Error> {
		self.inner.next().await
	}

	/// Poll for the next record, without blocking.
	pub fn poll_next(&mut self, waiter: &kio::Waiter) -> std::task::Poll<Result<Option<Record>, moq_json::Error>> {
		self.inner.poll_next(waiter)
	}
}

#[cfg(test)]
mod test {
	use std::task::Poll;

	use super::*;

	/// Drain every record currently available without blocking.
	fn drain(mut consumer: Consumer) -> Vec<Record> {
		let waiter = kio::Waiter::noop();
		let mut out = Vec::new();
		while let Poll::Ready(Ok(Some(record))) = consumer.poll_next(&waiter) {
			out.push(record);
		}
		out
	}

	fn frame(timestamp_us: u64, keyframe: bool) -> crate::container::Frame {
		crate::container::Frame {
			timestamp: Timestamp::from_micros(timestamp_us).unwrap(),
			payload: bytes::Bytes::from_static(&[0xDE, 0xAD]),
			keyframe,
			duration: None,
		}
	}

	#[test]
	fn records_group_opens_in_milliseconds() {
		let mut broadcast = moq_net::Broadcast::new().produce();
		let producer = Producer::new(&mut broadcast, "video0").unwrap();
		assert_eq!(producer.track, "video0.timeline");

		let track = broadcast.create_track(moq_net::Track::new("video0")).unwrap();
		let mut media = crate::container::Producer::with_config(
			track,
			crate::catalog::hang::Container::Legacy,
			crate::container::ProducerConfig::default().with_timeline(producer.clone()),
		);

		media.write(frame(0, true)).unwrap(); // group 0 @ 0us
		media.write(frame(2_000_000, false)).unwrap(); // extends group 0
		media.write(frame(4_000_000, true)).unwrap(); // group 1 @ 4_000_000us
		media.finish().unwrap();

		// pts is in milliseconds (the default timescale), not the micros the media carries.
		let records = drain(producer.consume());
		assert_eq!(records, vec![Record::new(0, 0), Record::new(1, 4_000)]);
	}

	#[test]
	fn granularity_throttles_records() {
		let mut broadcast = moq_net::Broadcast::new().produce();
		let mut producer = Producer::new(&mut broadcast, "audio0").unwrap();

		// Default granularity is 1s. Group opens 300ms apart, all within a second of the first,
		// then one past it: only the first and the one past the granularity are recorded.
		for (seq, ms) in [(0u64, 0u64), (1, 300), (2, 600), (3, 900), (4, 1200)] {
			producer.record(seq, Timestamp::from_millis(ms).unwrap()).unwrap();
		}
		producer.finish().unwrap();

		let records = drain(producer.consume());
		assert_eq!(records, vec![Record::new(0, 0), Record::new(4, 1200)]);
	}

	#[test]
	fn section_advertises_track_and_wall() {
		let mut broadcast = moq_net::Broadcast::new().produce();
		let producer = Producer::new(&mut broadcast, "audio0").unwrap();

		let section = producer.section();
		assert_eq!(section.track, "audio0.timeline");
		assert_eq!(section.timescale, 1000);
		assert_eq!(section.wall, None);

		// pts 0 observed at Unix ms 1_751_846_400_000 => wall of pts 0 is that time minus the moq
		// epoch (ms timescale).
		let moq = hang::catalog::MOQ_EPOCH_UNIX_MILLIS;
		producer.set_wall(Timestamp::from_micros(0).unwrap(), 1_751_846_400_000);
		assert_eq!(producer.section().wall, Some(1_751_846_400_000 - moq));

		// A nonzero pts extrapolates back to pts 0: a frame at pts 2s observed at that wall time
		// means pts 0 was 2s (2000 ms) earlier.
		producer.set_wall(Timestamp::from_micros(2_000_000).unwrap(), 1_751_846_400_000);
		assert_eq!(producer.section().wall, Some(1_751_846_400_000 - moq - 2_000));
	}

	#[test]
	fn consumer_reads_the_named_track() {
		let mut broadcast = moq_net::Broadcast::new().produce();
		let mut producer = Producer::new(&mut broadcast, "video0").unwrap();
		producer.record(3, Timestamp::from_micros(7_000).unwrap()).unwrap();
		producer.finish().unwrap();

		// Subscribe by the advertised name, like a remote consumer reading the catalog would.
		let subscriber = broadcast
			.consume()
			.subscribe_track(&moq_net::Track::new(&producer.section().track))
			.unwrap();
		let mut consumer = Consumer::new(subscriber, producer.section().timescale);
		let records = drain_ref(&mut consumer);
		assert_eq!(records, vec![Record::new(3, 7)]);
		assert_eq!(consumer.pts_micros(7), 7_000);
	}

	fn drain_ref(consumer: &mut Consumer) -> Vec<Record> {
		let waiter = kio::Waiter::noop();
		let mut out = Vec::new();
		while let Poll::Ready(Ok(Some(record))) = consumer.poll_next(&waiter) {
			out.push(record);
		}
		out
	}
}
