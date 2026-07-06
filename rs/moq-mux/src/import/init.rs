use bytes::Bytes;

pub use crate::catalog::{AudioHint, VideoHint};

/// Initial bytes and optional catalog fields for a single media track.
///
/// `format` selects the codec or container parser. `data` carries the usual
/// codec/container init bytes when available. `audio` or `video` can provide the
/// catalog fields up front, letting single-track importers publish their catalog
/// entry before the first encoded frame when the required fields are complete.
#[derive(Clone, Debug, Default, PartialEq)]
#[non_exhaustive]
pub struct Init {
	/// The media format, e.g. `aac`, `opus`, `avc3`, or `fmp4`.
	pub format: String,
	/// Codec or container initialization bytes.
	pub data: Bytes,
	/// Optional audio catalog fields for single audio tracks.
	pub audio: Option<AudioHint>,
	/// Optional video catalog fields for single video tracks.
	pub video: Option<VideoHint>,
}

impl Init {
	/// Create an init value with only a format and byte buffer.
	pub fn new(format: impl Into<String>, data: impl Into<Bytes>) -> Self {
		Self {
			format: format.into(),
			data: data.into(),
			audio: None,
			video: None,
		}
	}

	/// Add optional audio catalog fields.
	pub fn with_audio(mut self, hint: AudioHint) -> Self {
		self.audio = Some(hint);
		self
	}

	/// Add optional video catalog fields.
	pub fn with_video(mut self, hint: VideoHint) -> Self {
		self.video = Some(hint);
		self
	}
}
