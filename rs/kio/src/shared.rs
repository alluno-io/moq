//! A two-sided shared-state channel: both ends mutate one lock-guarded value.
//!
//! Unlike [`Producer`](crate::Producer)/[`Consumer`](crate::Consumer) (one writer,
//! many read-only observers), a [`Sender`] and a [`Receiver`] *both* hold mutable
//! access to the shared `T` by design. It's the primitive for a reverse queue: many
//! senders enqueue (and can dedup against what's already there), one or more receivers
//! drain, all under a single mutex, so the dedup is a plain lookup rather than a race.
//!
//! Liveness is channel-style, not condvar-style. A bare condvar blocks forever when a
//! predicate can never be satisfied; here a wait resolves to `None` when the *opposite*
//! side has no live handles. A drain (`Receiver`) ends once every `Sender` is gone, and
//! an enqueue (`Sender`) reports `None` once every `Receiver` is gone. The two handle
//! types are otherwise symmetric (both `DerefMut<T>` through the returned guard); they
//! differ only in which counterpart's disappearance closes the wait.

use std::{
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	task::Poll,
};

use crate::{
	State,
	lock::Lock,
	producer::{Mut, Ref},
	waiter::*,
};

/// Live-handle counts for the two sides. A side's wait closes when the opposite count
/// hits zero, which is what turns a shared mutex into a channel.
struct Counts {
	senders: AtomicUsize,
	receivers: AtomicUsize,
}

/// The enqueue side of a [`shared`](self) channel.
///
/// Clone-counted: cloning mints another sender. [`lock`](Self::lock) hands back a mutable
/// guard unless every [`Receiver`] is gone, in which case there is nobody to drain and it
/// returns `None`.
pub struct Sender<T> {
	state: Lock<State<T>>,
	counts: Arc<Counts>,
}

impl<T: Default> Default for Sender<T> {
	fn default() -> Self {
		Self {
			state: Lock::new(State::default()),
			counts: Arc::new(Counts {
				senders: AtomicUsize::new(1),
				receivers: AtomicUsize::new(0),
			}),
		}
	}
}

impl<T> Sender<T> {
	/// Mint a [`Receiver`] that drains this channel.
	pub fn receiver(&self) -> Receiver<T> {
		self.counts.receivers.fetch_add(1, Ordering::AcqRel);
		Receiver {
			state: self.state.clone(),
			counts: self.counts.clone(),
		}
	}

	/// Lock the shared state for mutation.
	///
	/// Unconditional: unlike a queue-enqueue that only makes sense with a live drainer, a
	/// [`Sender`] can always mutate the shared value (e.g. a producer maintaining a registry
	/// that a [`Receiver`] isn't required for). Gate enqueue paths on
	/// [`has_receivers`](Self::has_receivers). Mutating through the returned [`Mut`] wakes a
	/// waiting receiver on drop.
	pub fn lock(&self) -> Mut<'_, T> {
		Mut::new(self.state.lock())
	}

	/// Read-only access to the shared state, without waking anyone.
	pub fn read(&self) -> Ref<'_, T> {
		Ref {
			state: self.state.lock(),
		}
	}

	/// Whether any [`Receiver`] is currently live.
	///
	/// Gate a queue enqueue on this: with no receiver, nobody will ever drain it. Checked
	/// while holding [`lock`](Self::lock) it is ordered against a concurrent last-receiver
	/// drop (which locks to run its cleanup), so `true` here means the request won't be
	/// stranded (at worst it's rejected by that cleanup, which is the same benign race the
	/// queue already tolerates).
	pub fn has_receivers(&self) -> bool {
		self.counts.receivers.load(Ordering::Acquire) > 0
	}

	/// Returns `true` if both handles share the same channel.
	pub fn same_channel(&self, other: &Sender<T>) -> bool {
		self.state.is_clone(&other.state)
	}
}

impl<T> Clone for Sender<T> {
	fn clone(&self) -> Self {
		self.counts.senders.fetch_add(1, Ordering::Relaxed);
		Self {
			state: self.state.clone(),
			counts: self.counts.clone(),
		}
	}
}

impl<T> Drop for Sender<T> {
	fn drop(&mut self) {
		let prev = self.counts.senders.fetch_sub(1, Ordering::AcqRel);
		if prev > 1 {
			return;
		}

		// Last sender gone: wake receivers so a pending drain observes `senders == 0`
		// and resolves to `None` instead of blocking forever.
		let mut waiters = self.state.lock().waiters_value.take();
		waiters.wake();
	}
}

/// The drain side of a [`shared`](self) channel.
///
/// Clone-counted, so several drainers can share one queue (work-stealing). Minted from a
/// [`Sender`] via [`Sender::receiver`].
pub struct Receiver<T> {
	state: Lock<State<T>>,
	counts: Arc<Counts>,
}

impl<T> Receiver<T> {
	/// Mint a [`Sender`] onto the same channel.
	pub fn sender(&self) -> Sender<T> {
		self.counts.senders.fetch_add(1, Ordering::Relaxed);
		Sender {
			state: self.state.clone(),
			counts: self.counts.clone(),
		}
	}

	/// Poll for the shared state to satisfy `pred`, then hand back a mutable guard to
	/// drain it.
	///
	/// `pred` sees only a `&T`, so it can't flag the state modified and spuriously wake
	/// this poll (the same footgun [`Producer::poll`](crate::Producer::poll) avoids).
	/// Returns `Ready(None)` once every [`Sender`] is gone and `pred` is still unsatisfied
	/// (drain-then-close, like an mpsc receiver). Registers `waiter` while pending.
	pub fn poll_lock_when<F>(&self, waiter: &Waiter, mut pred: F) -> Poll<Option<Mut<'_, T>>>
	where
		F: FnMut(&T) -> bool,
	{
		let guard = Ref {
			state: self.state.lock(),
		};
		if pred(&guard) {
			return Poll::Ready(Some(Mut::new(guard.state)));
		}

		let mut state = guard.state;
		if self.counts.senders.load(Ordering::Acquire) == 0 {
			return Poll::Ready(None);
		}

		waiter.register(&mut state.waiters_value);

		// Re-check after registering to close the TOCTOU window where the last sender
		// drops between the check above and the registration.
		if self.counts.senders.load(Ordering::Acquire) == 0 {
			return Poll::Ready(None);
		}

		Poll::Pending
	}

	/// Await the next drainable state: resolves with a guard once `pred` holds, or `None`
	/// once every [`Sender`] is gone.
	pub async fn recv<F>(&self, mut pred: F) -> Option<Mut<'_, T>>
	where
		F: FnMut(&T) -> bool + Unpin,
	{
		crate::wait(move |waiter| self.poll_lock_when(waiter, &mut pred)).await
	}

	/// Unconditionally lock for mutation.
	///
	/// Unlike [`poll_lock_when`](Self::poll_lock_when) this never waits or reports closure;
	/// it's the direct-access counterpart used for cleanup (e.g. draining the queue in a
	/// last-receiver `Drop`).
	pub fn lock(&self) -> Mut<'_, T> {
		Mut::new(self.state.lock())
	}

	/// Returns `true` if this is the only remaining receiver.
	///
	/// Racy in general; intended for a receiver's own `Drop` (where this handle has not yet
	/// been counted out) to gate last-receiver cleanup, mirroring
	/// [`Producer::is_last`](crate::Producer::is_last).
	pub fn is_last(&self) -> bool {
		self.counts.receivers.load(Ordering::Acquire) == 1
	}

	/// Poll for every [`Sender`] to be gone (the channel's "closed" for a receiver).
	pub fn poll_closed(&self, waiter: &Waiter) -> Poll<()> {
		let mut state = self.state.lock();
		if self.counts.senders.load(Ordering::Acquire) == 0 {
			return Poll::Ready(());
		}
		waiter.register(&mut state.waiters_value);
		if self.counts.senders.load(Ordering::Acquire) == 0 {
			return Poll::Ready(());
		}
		Poll::Pending
	}

	/// Await every [`Sender`] being dropped.
	pub async fn closed(&self) {
		crate::wait(move |waiter| self.poll_closed(waiter)).await
	}

	/// Returns `true` if both handles share the same channel.
	pub fn same_channel(&self, other: &Receiver<T>) -> bool {
		self.state.is_clone(&other.state)
	}
}

impl<T> Clone for Receiver<T> {
	fn clone(&self) -> Self {
		self.counts.receivers.fetch_add(1, Ordering::Relaxed);
		Self {
			state: self.state.clone(),
			counts: self.counts.clone(),
		}
	}
}

impl<T> Drop for Receiver<T> {
	fn drop(&mut self) {
		let prev = self.counts.receivers.fetch_sub(1, Ordering::AcqRel);
		if prev > 1 {
			return;
		}

		// Last receiver gone: wake senders so a pending enqueue-wait resolves.
		let mut waiters = self.state.lock().waiters_value.take();
		waiters.wake();
	}
}

#[cfg(test)]
mod test {
	use std::{
		future::Future,
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		task::{Context, Wake, Waker},
	};

	use super::*;

	/// A waker that counts how many times it was woken (mirrors `tests.rs`).
	struct CountWaker(AtomicUsize);
	impl CountWaker {
		fn count(&self) -> usize {
			self.0.load(Ordering::SeqCst)
		}
	}
	impl Wake for CountWaker {
		fn wake(self: Arc<Self>) {
			self.0.fetch_add(1, Ordering::SeqCst);
		}
		fn wake_by_ref(self: &Arc<Self>) {
			self.0.fetch_add(1, Ordering::SeqCst);
		}
	}
	fn counting() -> (Arc<CountWaker>, Waker) {
		let waker = Arc::new(CountWaker(AtomicUsize::new(0)));
		let w = Waker::from(waker.clone());
		(waker, w)
	}

	#[test]
	fn enqueue_then_drain() {
		let sender = Sender::<Vec<u32>>::default();
		let receiver = sender.receiver();
		let waiter = Waiter::noop();

		let nonempty = |q: &Vec<u32>| !q.is_empty();

		// Nothing queued yet.
		assert!(matches!(receiver.poll_lock_when(&waiter, nonempty), Poll::Pending));

		// A sender enqueues.
		sender.lock().push(1);

		// The receiver drains it.
		let Poll::Ready(Some(mut guard)) = receiver.poll_lock_when(&waiter, nonempty) else {
			panic!("expected a drainable guard");
		};
		assert_eq!(guard.pop(), Some(1));
	}

	#[test]
	fn has_receivers_tracks_receiver_presence() {
		let sender = Sender::<Vec<u32>>::default();
		// No receiver minted yet.
		assert!(!sender.has_receivers());

		let receiver = sender.receiver();
		assert!(sender.has_receivers());

		drop(receiver);
		assert!(!sender.has_receivers(), "dropping the last receiver reverts to false");
	}

	#[test]
	fn drain_closes_when_senders_gone() {
		let sender = Sender::<Vec<u32>>::default();
		let receiver = sender.receiver();
		let waiter = Waiter::noop();

		drop(sender);

		// No senders left and nothing queued: the drain resolves to None rather than
		// blocking forever.
		assert!(matches!(
			receiver.poll_lock_when(&waiter, |q| !q.is_empty()),
			Poll::Ready(None)
		));
	}

	#[test]
	fn recv_wakes_on_enqueue() {
		let sender = Sender::<Vec<u32>>::default();
		let receiver = sender.receiver();

		let (waker, w) = counting();
		let mut cx = Context::from_waker(&w);

		let mut recv = Box::pin(receiver.recv(|q| !q.is_empty()));
		assert!(
			matches!(recv.as_mut().poll(&mut cx), Poll::Pending),
			"pending until enqueue"
		);

		sender.lock().push(7);
		assert!(waker.count() >= 1, "enqueue should wake the drain");

		let Poll::Ready(Some(mut guard)) = recv.as_mut().poll(&mut cx) else {
			panic!("expected a drainable guard after enqueue");
		};
		assert_eq!(guard.pop(), Some(7));
	}

	#[test]
	fn is_last_tracks_receiver_count() {
		let sender = Sender::<Vec<u32>>::default();
		let receiver = sender.receiver();
		assert!(receiver.is_last());

		let clone = receiver.clone();
		assert!(!receiver.is_last());
		drop(clone);
		assert!(receiver.is_last());
	}
}
