use std::collections::HashMap;
use std::str::FromStr;

use bytes::Bytes;

use crate::error::MoqError;

#[derive(Clone, uniffi::Record)]
pub struct MoqDimensions {
	pub width: u32,
	pub height: u32,
}

#[derive(Clone, uniffi::Enum)]
pub enum Container {
	Legacy,
	Cmaf { init: Vec<u8> },
	Loc,
}

impl From<hang::catalog::Container> for Container {
	fn from(container: hang::catalog::Container) -> Self {
		match container {
			hang::catalog::Container::Legacy => Self::Legacy,
			hang::catalog::Container::Cmaf { init, .. } => Self::Cmaf { init: init.to_vec() },
			hang::catalog::Container::Loc => Self::Loc,
		}
	}
}

impl From<Container> for hang::catalog::Container {
	fn from(container: Container) -> Self {
		match container {
			Container::Legacy => Self::Legacy,
			Container::Cmaf { init } => Self::Cmaf { init: init.into() },
			Container::Loc => Self::Loc,
		}
	}
}

#[derive(uniffi::Record)]
pub struct MoqCatalog {
	pub video: HashMap<String, MoqVideo>,
	pub audio: HashMap<String, MoqAudio>,
	pub display: Option<MoqDimensions>,
	pub rotation: Option<f64>,
	pub flip: Option<bool>,
	/// Untyped application catalog sections, keyed by section name, each value a JSON string.
	/// These are the top-level catalog keys beyond `video`/`audio`, carried through verbatim
	/// (parse the JSON yourself). Set them on the publish side with
	/// [`set_catalog_section`](crate::producer::MoqBroadcastProducer::set_catalog_section).
	pub sections: HashMap<String, String>,
}

#[derive(Clone, uniffi::Record)]
pub struct MoqVideo {
	pub codec: String,
	pub description: Option<Vec<u8>>,
	pub coded: Option<MoqDimensions>,
	pub display_aspect: Option<MoqDimensions>,
	pub bitrate: Option<u64>,
	pub framerate: Option<f64>,
	pub container: Container,
}

#[derive(Clone, uniffi::Record)]
pub struct MoqAudio {
	pub codec: String,
	pub description: Option<Vec<u8>>,
	pub sample_rate: u32,
	pub channel_count: u32,
	pub bitrate: Option<u64>,
	pub container: Container,
}

#[derive(Clone, uniffi::Record)]
pub struct MoqInit {
	pub format: String,
	pub data: Vec<u8>,
	#[uniffi(default = None)]
	pub audio: Option<MoqAudioHint>,
	#[uniffi(default = None)]
	pub video: Option<MoqVideoHint>,
}

#[derive(Clone, uniffi::Record)]
pub struct MoqAudioHint {
	#[uniffi(default = None)]
	pub codec: Option<String>,
	#[uniffi(default = None)]
	pub description: Option<Vec<u8>>,
	#[uniffi(default = None)]
	pub sample_rate: Option<u32>,
	#[uniffi(default = None)]
	pub channel_count: Option<u32>,
	#[uniffi(default = None)]
	pub bitrate: Option<u64>,
	#[uniffi(default = None)]
	pub container: Option<Container>,
	#[uniffi(default = None)]
	pub jitter_ms: Option<u64>,
}

#[derive(Clone, uniffi::Record)]
pub struct MoqVideoHint {
	#[uniffi(default = None)]
	pub codec: Option<String>,
	#[uniffi(default = None)]
	pub description: Option<Vec<u8>>,
	#[uniffi(default = None)]
	pub coded: Option<MoqDimensions>,
	#[uniffi(default = None)]
	pub display_aspect: Option<MoqDimensions>,
	#[uniffi(default = None)]
	pub bitrate: Option<u64>,
	#[uniffi(default = None)]
	pub framerate: Option<f64>,
	#[uniffi(default = None)]
	pub optimize_for_latency: Option<bool>,
	#[uniffi(default = None)]
	pub container: Option<Container>,
	#[uniffi(default = None)]
	pub jitter_ms: Option<u64>,
}

/// A media frame.
#[derive(uniffi::Record)]
pub struct MoqFrame {
	pub payload: Vec<u8>,
	pub timestamp_us: u64,
	pub keyframe: bool,
}

impl TryFrom<MoqInit> for moq_mux::import::Init {
	type Error = MoqError;

	fn try_from(init: MoqInit) -> Result<Self, Self::Error> {
		let mut out = moq_mux::import::Init::new(init.format, init.data);
		if let Some(audio) = init.audio {
			out.audio = Some(audio.try_into()?);
		}
		if let Some(video) = init.video {
			out.video = Some(video.try_into()?);
		}
		Ok(out)
	}
}

impl TryFrom<MoqAudioHint> for moq_mux::import::AudioHint {
	type Error = MoqError;

	fn try_from(hint: MoqAudioHint) -> Result<Self, Self::Error> {
		let mut out = Self::default();
		out.codec = hint
			.codec
			.as_deref()
			.map(hang::catalog::AudioCodec::from_str)
			.transpose()
			.map_err(|err| MoqError::Codec(format!("invalid audio codec: {err}")))?;
		out.description = hint.description.map(Bytes::from);
		out.sample_rate = hint.sample_rate;
		out.channel_count = hint.channel_count;
		out.bitrate = hint.bitrate;
		out.container = hint.container.map(Into::into);
		out.jitter = hint.jitter_ms.map(std::time::Duration::from_millis);
		Ok(out)
	}
}

impl TryFrom<MoqVideoHint> for moq_mux::import::VideoHint {
	type Error = MoqError;

	fn try_from(hint: MoqVideoHint) -> Result<Self, Self::Error> {
		let mut out = Self::default();
		out.codec = hint
			.codec
			.as_deref()
			.map(hang::catalog::VideoCodec::from_str)
			.transpose()
			.map_err(|err| MoqError::Codec(format!("invalid video codec: {err}")))?;
		out.description = hint.description.map(Bytes::from);
		out.coded_width = hint.coded.as_ref().map(|d| d.width);
		out.coded_height = hint.coded.as_ref().map(|d| d.height);
		out.display_aspect_width = hint.display_aspect.as_ref().map(|d| d.width);
		out.display_aspect_height = hint.display_aspect.as_ref().map(|d| d.height);
		out.bitrate = hint.bitrate;
		out.framerate = hint.framerate;
		out.optimize_for_latency = hint.optimize_for_latency;
		out.container = hint.container.map(Into::into);
		out.jitter = hint.jitter_ms.map(std::time::Duration::from_millis);
		Ok(out)
	}
}

pub(crate) fn convert_catalog(catalog: &moq_mux::catalog::hang::Catalog<moq_mux::catalog::hang::Extra>) -> MoqCatalog {
	let video = catalog
		.video
		.renditions
		.iter()
		.map(|(name, config)| {
			(
				name.clone(),
				MoqVideo {
					codec: config.codec.to_string(),
					description: config.description.as_ref().map(|d| d.to_vec()),
					coded: match (config.coded_width, config.coded_height) {
						(Some(w), Some(h)) => Some(MoqDimensions { width: w, height: h }),
						_ => None,
					},
					display_aspect: match (config.display_aspect_width, config.display_aspect_height) {
						(Some(w), Some(h)) => Some(MoqDimensions { width: w, height: h }),
						_ => None,
					},
					bitrate: config.bitrate,
					framerate: config.framerate,
					container: config.container.clone().into(),
				},
			)
		})
		.collect();

	let audio = catalog
		.audio
		.renditions
		.iter()
		.map(|(name, config)| {
			(
				name.clone(),
				MoqAudio {
					codec: config.codec.to_string(),
					description: config.description.as_ref().map(|d| d.to_vec()),
					sample_rate: config.sample_rate,
					channel_count: config.channel_count,
					bitrate: config.bitrate,
					container: config.container.clone().into(),
				},
			)
		})
		.collect();

	let display = catalog.video.display.as_ref().map(|d| MoqDimensions {
		width: d.width,
		height: d.height,
	});

	let sections = catalog
		.sections()
		.map(|(name, value)| (name.clone(), value.to_string()))
		.collect();

	MoqCatalog {
		video,
		audio,
		display,
		rotation: catalog.video.rotation,
		flip: catalog.video.flip,
		sections,
	}
}
