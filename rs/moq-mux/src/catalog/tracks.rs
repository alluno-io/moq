use std::marker::PhantomData;

use bytes::Bytes;

use super::Producer;
use super::hang::{Catalog, CatalogExt};

mod sealed {
	pub trait Sealed {}
}

/// The media kind of a reserved rendition, selecting its config type and catalog slot.
///
/// Implemented only by [`Video`] and [`Audio`]; used as the `K` in
/// [`Rendition`] and [`Reserved::init`].
pub trait Kind: sealed::Sealed + 'static {
	/// The catalog config type carried by this kind ([`VideoConfig`](hang::catalog::VideoConfig)
	/// or [`AudioConfig`](hang::catalog::AudioConfig)).
	type Config;
	/// The optional caller-provided fields merged into this kind's config.
	type Hint: Clone + Default;

	#[doc(hidden)]
	fn insert<E: CatalogExt>(catalog: &mut Catalog<E>, name: &str, config: Self::Config);
	#[doc(hidden)]
	fn with_mut<E: CatalogExt>(catalog: &mut Catalog<E>, name: &str, f: impl FnOnce(&mut Self::Config));
	#[doc(hidden)]
	fn remove<E: CatalogExt>(catalog: &mut Catalog<E>, name: &str);
	#[doc(hidden)]
	fn apply_hint(config: &mut Self::Config, hint: &Self::Hint) -> crate::Result<()>;
}

/// Video rendition marker for [`Rendition`] / [`Reserved::init`].
pub enum Video {}
/// Audio rendition marker for [`Rendition`] / [`Reserved::init`].
pub enum Audio {}

/// Optional catalog fields for an audio track.
#[derive(Clone, Default, Debug, PartialEq)]
#[non_exhaustive]
pub struct AudioHint {
	/// The audio codec string.
	pub codec: Option<hang::catalog::AudioCodec>,
	/// Decoder-specific initialization bytes.
	pub description: Option<Bytes>,
	/// The sample rate in Hz.
	pub sample_rate: Option<u32>,
	/// The number of audio channels.
	pub channel_count: Option<u32>,
	/// The maximum bitrate in bits per second.
	pub bitrate: Option<u64>,
	/// The frame container used on the track.
	pub container: Option<hang::catalog::Container>,
	/// The maximum time before the next frame is emitted.
	pub jitter: Option<std::time::Duration>,
}

/// Optional catalog fields for a video track.
#[derive(Clone, Default, Debug, PartialEq)]
#[non_exhaustive]
pub struct VideoHint {
	/// The video codec string.
	pub codec: Option<hang::catalog::VideoCodec>,
	/// Decoder-specific initialization bytes.
	pub description: Option<Bytes>,
	/// The encoded width in pixels.
	pub coded_width: Option<u32>,
	/// The encoded height in pixels.
	pub coded_height: Option<u32>,
	/// The display aspect width.
	pub display_aspect_width: Option<u32>,
	/// The display aspect height.
	pub display_aspect_height: Option<u32>,
	/// The maximum bitrate in bits per second.
	pub bitrate: Option<u64>,
	/// The frame rate in frames per second.
	pub framerate: Option<f64>,
	/// Whether the decoder should optimize for latency.
	pub optimize_for_latency: Option<bool>,
	/// The frame container used on the track.
	pub container: Option<hang::catalog::Container>,
	/// The maximum time before the next frame is emitted.
	pub jitter: Option<std::time::Duration>,
}

fn check_field<T>(field: &'static str, actual: &T, expected: &T) -> crate::Result<()>
where
	T: PartialEq + std::fmt::Debug,
{
	if actual != expected {
		return Err(crate::Error::InitMismatch {
			field,
			actual: format!("{actual:?}"),
			expected: format!("{expected:?}"),
		});
	}
	Ok(())
}

impl AudioHint {
	/// Build a catalog config when all required audio fields are available.
	pub fn to_config(&self) -> crate::Result<Option<hang::catalog::AudioConfig>> {
		let (Some(codec), Some(sample_rate), Some(channel_count)) =
			(self.codec.clone(), self.sample_rate, self.channel_count)
		else {
			return Ok(None);
		};

		let mut config = hang::catalog::AudioConfig::new(codec, sample_rate, channel_count);
		self.apply(&mut config)?;
		Ok(Some(config))
	}

	/// Validate and merge these fields into an audio config.
	pub fn apply(&self, config: &mut hang::catalog::AudioConfig) -> crate::Result<()> {
		if let Some(codec) = &self.codec {
			check_field("audio.codec", &config.codec, codec)?;
		}
		if let Some(sample_rate) = self.sample_rate {
			check_field("audio.sample_rate", &config.sample_rate, &sample_rate)?;
		}
		if let Some(channel_count) = self.channel_count {
			check_field("audio.channel_count", &config.channel_count, &channel_count)?;
		}
		if let Some(description) = &self.description {
			if let Some(actual) = &config.description {
				check_field("audio.description", actual, description)?;
			}
			config.description = Some(description.clone());
		}
		if let Some(bitrate) = self.bitrate {
			config.bitrate = Some(bitrate);
		}
		if let Some(container) = &self.container {
			check_field("audio.container", &config.container, container)?;
			config.container = container.clone();
		}
		if let Some(jitter) = self.jitter {
			config.jitter = Some(jitter);
		}
		Ok(())
	}
}

impl VideoHint {
	/// Build a catalog config when the required video codec is available.
	pub fn to_config(&self) -> crate::Result<Option<hang::catalog::VideoConfig>> {
		let Some(codec) = self.codec.clone() else {
			return Ok(None);
		};

		let mut config = hang::catalog::VideoConfig::new(codec);
		self.apply(&mut config)?;
		Ok(Some(config))
	}

	/// Validate and merge these fields into a video config.
	pub fn apply(&self, config: &mut hang::catalog::VideoConfig) -> crate::Result<()> {
		if let Some(codec) = &self.codec {
			check_field("video.codec", &config.codec, codec)?;
		}
		if let Some(description) = &self.description {
			if let Some(actual) = &config.description {
				check_field("video.description", actual, description)?;
			}
			config.description = Some(description.clone());
		}
		if let Some(coded_width) = self.coded_width {
			if let Some(actual) = config.coded_width {
				check_field("video.coded_width", &actual, &coded_width)?;
			}
			config.coded_width = Some(coded_width);
		}
		if let Some(coded_height) = self.coded_height {
			if let Some(actual) = config.coded_height {
				check_field("video.coded_height", &actual, &coded_height)?;
			}
			config.coded_height = Some(coded_height);
		}
		if let Some(display_aspect_width) = self.display_aspect_width {
			if let Some(actual) = config.display_aspect_width {
				check_field("video.display_aspect_width", &actual, &display_aspect_width)?;
			}
			config.display_aspect_width = Some(display_aspect_width);
		}
		if let Some(display_aspect_height) = self.display_aspect_height {
			if let Some(actual) = config.display_aspect_height {
				check_field("video.display_aspect_height", &actual, &display_aspect_height)?;
			}
			config.display_aspect_height = Some(display_aspect_height);
		}
		if let Some(bitrate) = self.bitrate {
			config.bitrate = Some(bitrate);
		}
		if let Some(framerate) = self.framerate {
			if let Some(actual) = config.framerate {
				check_field("video.framerate", &actual, &framerate)?;
			}
			config.framerate = Some(framerate);
		}
		if let Some(optimize_for_latency) = self.optimize_for_latency {
			config.optimize_for_latency = Some(optimize_for_latency);
		}
		if let Some(container) = &self.container {
			check_field("video.container", &config.container, container)?;
			config.container = container.clone();
		}
		if let Some(jitter) = self.jitter {
			config.jitter = Some(jitter);
		}
		Ok(())
	}
}

impl sealed::Sealed for Video {}
impl sealed::Sealed for Audio {}

impl Kind for Video {
	type Config = hang::catalog::VideoConfig;
	type Hint = VideoHint;

	fn insert<E: CatalogExt>(catalog: &mut Catalog<E>, name: &str, config: Self::Config) {
		catalog.video.renditions.insert(name.to_string(), config);
	}
	fn with_mut<E: CatalogExt>(catalog: &mut Catalog<E>, name: &str, f: impl FnOnce(&mut Self::Config)) {
		if let Some(config) = catalog.video.renditions.get_mut(name) {
			f(config);
		}
	}
	fn remove<E: CatalogExt>(catalog: &mut Catalog<E>, name: &str) {
		catalog.video.renditions.remove(name);
	}
	fn apply_hint(config: &mut Self::Config, hint: &Self::Hint) -> crate::Result<()> {
		hint.apply(config)
	}
}

impl Kind for Audio {
	type Config = hang::catalog::AudioConfig;
	type Hint = AudioHint;

	fn insert<E: CatalogExt>(catalog: &mut Catalog<E>, name: &str, config: Self::Config) {
		catalog.audio.renditions.insert(name.to_string(), config);
	}
	fn with_mut<E: CatalogExt>(catalog: &mut Catalog<E>, name: &str, f: impl FnOnce(&mut Self::Config)) {
		if let Some(config) = catalog.audio.renditions.get_mut(name) {
			f(config);
		}
	}
	fn remove<E: CatalogExt>(catalog: &mut Catalog<E>, name: &str) {
		catalog.audio.renditions.remove(name);
	}
	fn apply_hint(config: &mut Self::Config, hint: &Self::Hint) -> crate::Result<()> {
		hint.apply(config)
	}
}

/// A clonable reservation context handed to importers so they declare their tracks up front.
///
/// Made via [`Producer::reserve`]. While any `Reserved` clone is alive the track set may still
/// grow, so the catalog is withheld from the broadcast. Each [`init`](Self::init) reserves a
/// rendition by name (config filled in later via the returned [`Rendition`] guard) and counts as
/// outstanding until that guard is fulfilled or dropped. Once every clone is dropped *and* every
/// reservation resolves, the first catalog snapshot is published atomically with the complete
/// track list, so a one-shot muxer (fMP4, MPEG-TS) never sees a half-converged catalog.
pub struct Reserved<E: CatalogExt = ()> {
	catalog: Producer<E>,
}

impl<E: CatalogExt> Reserved<E> {
	pub(super) fn new(catalog: Producer<E>) -> Self {
		catalog.add_reserver();
		Self { catalog }
	}

	/// Reserve a rendition of kind `K` under `name`, returning a guard to fill it in.
	///
	/// The guard holds its own `Reserved` clone, so the catalog stays withheld until the returned
	/// [`Rendition`] is [`set`](Rendition::set) (or dropped). Prefer [`video`](Self::video) /
	/// [`audio`](Self::audio) at call sites.
	pub fn init<K: Kind>(&self, name: impl Into<String>) -> Rendition<E, K> {
		Rendition::new(self.clone(), name, K::Hint::default())
	}

	/// Reserve a rendition of kind `K` with caller-provided catalog fields.
	pub fn init_with_hint<K: Kind>(&self, name: impl Into<String>, hint: K::Hint) -> Rendition<E, K> {
		Rendition::new(self.clone(), name, hint)
	}

	/// Reserve a video rendition; shorthand for [`init::<Video>`](Self::init).
	pub fn video(&self, name: impl Into<String>) -> Rendition<E, Video> {
		self.init::<Video>(name)
	}

	/// Reserve a video rendition with caller-provided catalog fields.
	pub fn video_with_hint(&self, name: impl Into<String>, hint: VideoHint) -> Rendition<E, Video> {
		self.init_with_hint::<Video>(name, hint)
	}

	/// Reserve an audio rendition; shorthand for [`init::<Audio>`](Self::init).
	pub fn audio(&self, name: impl Into<String>) -> Rendition<E, Audio> {
		self.init::<Audio>(name)
	}

	/// Reserve an audio rendition with caller-provided catalog fields.
	pub fn audio_with_hint(&self, name: impl Into<String>, hint: AudioHint) -> Rendition<E, Audio> {
		self.init_with_hint::<Audio>(name, hint)
	}

	/// Resolve a timestamp on the broadcast's shared clock (see [`Producer::timestamp`]).
	pub fn timestamp(&self, hint: Option<moq_net::Timestamp>) -> crate::Result<moq_net::Timestamp> {
		self.catalog.timestamp(hint)
	}

	/// The underlying catalog [`Producer`], for edits that outlive this reservation.
	///
	/// A container importer holds one to edit the catalog directly (e.g. its per-frame reconcile, or
	/// track removals after its initial set is declared) while the reservation itself is dropped to
	/// open the gate. The returned handle does not gate: only live `Reserved`s do.
	pub fn producer(&self) -> Producer<E> {
		self.catalog.clone()
	}
}

impl<E: CatalogExt> Clone for Reserved<E> {
	fn clone(&self) -> Self {
		self.catalog.add_reserver();
		Self {
			catalog: self.catalog.clone(),
		}
	}
}

impl<E: CatalogExt> Drop for Reserved<E> {
	fn drop(&mut self) {
		self.catalog.release_reserver();
	}
}

/// A reserved rendition of kind `K`, retired from the catalog on drop.
///
/// Made via [`Reserved::init`] (or [`video`](Reserved::video) / [`audio`](Reserved::audio)). Fill
/// it in with [`set`](Self::set) and refine it in place with [`update`](Self::update). Until it's
/// set (or dropped) it holds a [`Reserved`] clone, so an unresolved rendition keeps the initial
/// catalog publish gated. On drop the rendition is removed from the shared catalog.
pub struct Rendition<E: CatalogExt, K: Kind> {
	catalog: Producer<E>,
	name: String,
	/// The reservation this rendition holds until its config is set (or it's dropped unfulfilled).
	/// `Some` gates the initial publish; cleared by [`set`](Self::set).
	gate: Option<Reserved<E>>,
	/// Whether a config has been published, so a lazily-configured importer (e.g. H.264 before its
	/// SPS) holds the handle without a catalog entry, and drops without a spurious removal.
	present: bool,
	hint: K::Hint,
	_kind: PhantomData<fn() -> K>,
}

/// A single video track's catalog rendition. See [`Rendition`].
pub type VideoTrack<E = ()> = Rendition<E, Video>;
/// A single audio track's catalog rendition. See [`Rendition`].
pub type AudioTrack<E = ()> = Rendition<E, Audio>;

impl<E: CatalogExt, K: Kind> Rendition<E, K> {
	fn new(reserved: Reserved<E>, name: impl Into<String>, hint: K::Hint) -> Self {
		Self {
			catalog: reserved.catalog.clone(),
			gate: Some(reserved),
			name: name.into(),
			present: false,
			hint,
			_kind: PhantomData,
		}
	}

	/// The track name this rendition is keyed by.
	pub fn name(&self) -> &str {
		&self.name
	}

	/// Resolve a timestamp on the broadcast's shared clock (see [`Producer::timestamp`]).
	pub fn timestamp(&self, hint: Option<moq_net::Timestamp>) -> crate::Result<moq_net::Timestamp> {
		self.catalog.timestamp(hint)
	}

	/// Insert or replace the rendition, fulfilling the reservation and publishing the catalog.
	pub fn set(&mut self, mut config: K::Config) -> crate::Result<()> {
		K::apply_hint(&mut config, &self.hint)?;
		// Write the config first (still withheld, since we're holding our reservation), then release
		// the reservation. If this was the last one, the release flushes a complete snapshot.
		{
			let mut guard = self.catalog.lock();
			K::insert(&mut guard, &self.name, config);
		}
		self.present = true;
		self.gate = None;
		Ok(())
	}

	/// Refine the rendition in place (e.g. observed jitter), publishing if present.
	pub fn update(&mut self, f: impl FnOnce(&mut K::Config)) {
		if !self.present {
			return;
		}
		let mut guard = self.catalog.lock();
		K::with_mut(&mut guard, &self.name, f);
	}
}

impl<E: CatalogExt, K: Kind> Drop for Rendition<E, K> {
	fn drop(&mut self) {
		if self.present {
			// Removing mutates the catalog, so the guard publishes it (immediately if live, else it
			// accumulates until the gate opens).
			let mut guard = self.catalog.lock();
			K::remove(&mut guard, &self.name);
		}
		// Our reservation (`gate`) drops here. If still held (never set), its release flushes any
		// staged change; if already released by `set`, this is a no-op.
	}
}
