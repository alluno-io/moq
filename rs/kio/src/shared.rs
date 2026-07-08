//! A lock-guarded value that *both* sides mutate, with waker notification and per-side
//! liveness, built on the same counting the watch [`Producer`](crate::Producer) /
//! [`Consumer`](crate::Consumer) use.
//!
//! Nothing flows across it (it isn't a message pipe): a [`Sender`] and a [`Receiver`] both
//! lock the same `T` and mutate it in place. It's the primitive for a reverse queue where a
//! plain [`Consumer`](crate::Consumer) would otherwise have to illegally write back through
//! its read handle: senders enqueue (and can dedup against what's already there) while
//! receivers drain, all under one mutex, so the dedup is a plain lookup rather than a race.
//!
//! The two sides map onto the watch roles:
//! - A [`Sender`] is the producer role. It enqueues and never blocks: [`lock`](Sender::lock)
//!   hands back a guard that mutates unconditionally and reports whether a drainer exists
//!   ([`Guard::has_receivers`]). While no sender remains a receiver's drain resolves to `None`,
//!   though a receiver can resurrect the sender side via [`Receiver::sender`].
//! - A [`Receiver`] is the consumer role. It drains and can block: [`poll`](Receiver::poll) /
//!   [`wait`](Receiver::wait) park until the state is drainable, then hand back a guard.
//!
//! Liveness is channel-style, not condvar-style: a `Receiver`'s wait resolves to `None` once
//! every `Sender` is gone (drain-then-close, like an mpsc receiver) instead of blocking
//! forever. Both sides are clone-counted, and either can mint the other
//! ([`Sender::receiver`] / [`Receiver::sender`]).
//!
//! Receiver presence is the enqueue gate: with no receiver nobody will ever drain, so an
//! enqueue path checks [`Guard::has_receivers`] and bails. Read through the guard, that check
//! is ordered against the last receiver's drop (which locks to run its cleanup), so the two
//! can't interleave and strand work. A channel built with [`Sender::with_cleanup`] runs its
//! hook on the value when that last receiver drops, under the same lock, to reject whatever
//! is queued.

use std::{
	ops::{Deref, DerefMut},
	sync::{Arc, atomic::Ordering},
	task::Poll,
};

use crate::{
	Counts, State,
	lock::Lock,
	producer::{Mut, Ref},
	waiter::*,
};

/// Run on the value when the last [`Receiver`] drops, under the state lock.
type Cleanup<T> = Arc<dyn Fn(&mut T) + Send + Sync>;

/// The enqueue (producer-role) side of a [`shared`](self) channel.
///
/// Clone-counted: cloning mints another sender. [`lock`](Self::lock) hands back a mutable
/// [`Guard`]; while no sender remains a [`Receiver`]'s drain resolves to `None`.
pub struct Sender<T> {
	state: Lock<State<T>>,
	counts: Arc<Counts>,
	cleanup: Cleanup<T>,
}

impl<T: Default> Default for Sender<T> {
	fn default() -> Self {
		Self::new(T::default())
	}
}

impl<T> Sender<T> {
	/// Create a channel seeded with `value`, with no receivers yet and no cleanup hook.
	pub fn new(value: T) -> Self {
		Self::build(value, Arc::new(|_| {}))
	}

	/// Like [`new`](Self::new), but runs `on_unused` on the value when the last [`Receiver`]
	/// drops, under the state lock (atomic with the drop). Use it to reject queued work that
	/// nobody will ever drain once the last drainer is gone.
	pub fn with_cleanup(value: T, on_unused: impl Fn(&mut T) + Send + Sync + 'static) -> Self {
		Self::build(value, Arc::new(on_unused))
	}

	fn build(value: T, cleanup: Cleanup<T>) -> Self {
		Self {
			state: Lock::new(State::new(value)),
			counts: Arc::new(Counts::default()),
			cleanup,
		}
	}

	/// Mint a [`Receiver`] that drains this channel.
	pub fn receiver(&self) -> Receiver<T> {
		self.counts.consumers.fetch_add(1, Ordering::AcqRel);
		Receiver {
			state: self.state.clone(),
			counts: self.counts.clone(),
			cleanup: self.cleanup.clone(),
		}
	}

	/// Lock the shared state for mutation, returning a [`Guard`].
	///
	/// Unconditional: unlike a queue-enqueue that only makes sense with a live drainer, a
	/// [`Sender`] can always mutate the shared value (e.g. a producer maintaining a registry
	/// that a [`Receiver`] isn't required for). Gate enqueue paths on
	/// [`Guard::has_receivers`]. Mutating through the guard wakes a waiting receiver on drop.
	pub fn lock(&self) -> Guard<'_, T> {
		Guard {
			inner: Mut::new(self.state.lock()),
			counts: &self.counts,
		}
	}

	/// Read-only access to the shared state, without waking anyone.
	pub fn read(&self) -> Ref<'_, T> {
		Ref {
			state: self.state.lock(),
		}
	}

	/// Returns `true` if both handles share the same channel.
	pub fn same_channel(&self, other: &Sender<T>) -> bool {
		self.state.is_clone(&other.state)
	}
}

impl<T> Clone for Sender<T> {
	fn clone(&self) -> Self {
		self.counts.producers.fetch_add(1, Ordering::Relaxed);
		Self {
			state: self.state.clone(),
			counts: self.counts.clone(),
			cleanup: self.cleanup.clone(),
		}
	}
}

impl<T> Drop for Sender<T> {
	fn drop(&mut self) {
		let prev = self.counts.producers.fetch_sub(1, Ordering::AcqRel);
		if prev > 1 {
			return;
		}

		// Last sender gone: wake any parked drain so it re-polls, observes `producers == 0`, and
		// resolves to `None` instead of blocking forever. We track the live count (not a latch)
		// because a [`Receiver`] can resurrect the sender side via [`Receiver::sender`].
		let (mut value, mut closed) = {
			let mut state = self.state.lock();
			(state.waiters_value.take(), state.waiters_closed.take())
		};
		value.wake();
		closed.wake();
	}
}

/// A mutable lock guard over a [`Sender`]'s state, with access to receiver presence.
///
/// Derefs to `T`. Mutating through it wakes a waiting [`Receiver`] on drop.
pub struct Guard<'a, T> {
	inner: Mut<'a, T>,
	counts: &'a Counts,
}

impl<T> Guard<'_, T> {
	/// Whether any [`Receiver`] is currently live.
	///
	/// Gate a queue enqueue on this: with no receiver, nobody will ever drain it. Read while
	/// the lock is held, it is ordered against a concurrent last-receiver drop (which locks to
	/// run its cleanup), so an enqueue and that cleanup can't interleave and strand work.
	pub fn has_receivers(&self) -> bool {
		self.counts.consumers.load(Ordering::Acquire) > 0
	}
}

impl<T> Deref for Guard<'_, T> {
	type Target = T;

	fn deref(&self) -> &T {
		&self.inner
	}
}

impl<T> DerefMut for Guard<'_, T> {
	fn deref_mut(&mut self) -> &mut T {
		&mut self.inner
	}
}

/// The drain (consumer-role) side of a [`shared`](self) channel.
///
/// Clone-counted, so several drainers can share one queue (work-stealing). Minted from a
/// [`Sender`] via [`Sender::receiver`].
pub struct Receiver<T> {
	state: Lock<State<T>>,
	counts: Arc<Counts>,
	cleanup: Cleanup<T>,
}

impl<T> Receiver<T> {
	/// Mint a [`Sender`] onto the same channel.
	pub fn sender(&self) -> Sender<T> {
		self.counts.producers.fetch_add(1, Ordering::Relaxed);
		Sender {
			state: self.state.clone(),
			counts: self.counts.clone(),
			cleanup: self.cleanup.clone(),
		}
	}

	/// Poll a predicate; once it holds, hand back a mutable guard to drain the state.
	///
	/// Mirrors [`Producer::poll`](crate::Producer::poll): `f` only sees a [`Ref`] (so it
	/// can't flag the state modified and spuriously wake this poll), decides readiness, and
	/// the satisfied poll upgrades to a [`Mut`] with the lock still held. Returns
	/// `Ready(None)` once every [`Sender`] is gone and `f` is still pending (drain-then-close,
	/// like an mpsc receiver). Registers `waiter` while pending.
	pub fn poll<F>(&self, waiter: &Waiter, mut f: F) -> Poll<Option<Mut<'_, T>>>
	where
		F: FnMut(&Ref<'_, T>) -> Poll<()>,
	{
		let mut guard = Ref {
			state: self.state.lock(),
		};
		if let Poll::Ready(()) = f(&guard) {
			return Poll::Ready(Some(Mut::new(guard.state)));
		}

		if self.counts.producers.load(Ordering::Acquire) == 0 {
			return Poll::Ready(None);
		}

		waiter.register(&mut guard.state.waiters_value);

		// Re-check after registering to close the TOCTOU window where the last sender drops
		// between the check above and the registration.
		if self.counts.producers.load(Ordering::Acquire) == 0 {
			return Poll::Ready(None);
		}

		Poll::Pending
	}

	/// Await the next drainable state: resolves with a guard once `f` holds, or `None` once
	/// every [`Sender`] is gone. The async sibling of [`poll`](Self::poll).
	pub async fn wait<F>(&self, mut f: F) -> Option<Mut<'_, T>>
	where
		F: FnMut(&Ref<'_, T>) -> Poll<()> + Unpin,
	{
		crate::wait(move |waiter| self.poll(waiter, &mut f)).await
	}

	/// Read-only access to the shared state, without waking anyone.
	pub fn read(&self) -> Ref<'_, T> {
		Ref {
			state: self.state.lock(),
		}
	}

	/// Poll for every [`Sender`] to be gone (the channel's "closed" for a receiver).
	pub fn poll_closed(&self, waiter: &Waiter) -> Poll<()> {
		let mut state = self.state.lock();
		if self.counts.producers.load(Ordering::Acquire) == 0 {
			return Poll::Ready(());
		}
		waiter.register(&mut state.waiters_closed);
		if self.counts.producers.load(Ordering::Acquire) == 0 {
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
		self.counts.consumers.fetch_add(1, Ordering::Relaxed);
		Self {
			state: self.state.clone(),
			counts: self.counts.clone(),
			cleanup: self.cleanup.clone(),
		}
	}
}

impl<T> Drop for Receiver<T> {
	fn drop(&mut self) {
		// Decrement under the lock so the last-receiver cleanup is atomic with the count going
		// to zero, and an enqueue that read `has_receivers` under this same lock can't slip in
		// afterward and strand work.
		let mut state = self.state.lock();
		let prev = self.counts.consumers.fetch_sub(1, Ordering::AcqRel);
		if prev > 1 {
			return;
		}

		(self.cleanup)(&mut state.value);
		let mut waiters = state.waiters_consumer.take();
		drop(state);
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

	/// Ready once the queue has something to drain.
	fn nonempty(queue: &Ref<'_, Vec<u32>>) -> Poll<()> {
		if queue.is_empty() {
			Poll::Pending
		} else {
			Poll::Ready(())
		}
	}

	#[test]
	fn enqueue_then_drain() {
		let sender = Sender::<Vec<u32>>::default();
		let receiver = sender.receiver();
		let waiter = Waiter::noop();

		// Nothing queued yet.
		assert!(matches!(receiver.poll(&waiter, nonempty), Poll::Pending));

		// A sender enqueues.
		sender.lock().push(1);

		// The receiver drains it.
		let Poll::Ready(Some(mut guard)) = receiver.poll(&waiter, nonempty) else {
			panic!("expected a drainable guard");
		};
		assert_eq!(guard.pop(), Some(1));
	}

	#[test]
	fn has_receivers_tracks_receiver_presence() {
		let sender = Sender::<Vec<u32>>::default();
		// No receiver minted yet.
		assert!(!sender.lock().has_receivers());

		let receiver = sender.receiver();
		assert!(sender.lock().has_receivers());

		drop(receiver);
		assert!(
			!sender.lock().has_receivers(),
			"dropping the last receiver reverts to false"
		);
	}

	#[test]
	fn drain_closes_when_senders_gone() {
		let sender = Sender::<Vec<u32>>::default();
		let receiver = sender.receiver();
		let waiter = Waiter::noop();

		drop(sender);

		// No senders left and nothing queued: the drain resolves to None rather than
		// blocking forever.
		assert!(matches!(receiver.poll(&waiter, nonempty), Poll::Ready(None)));
	}

	#[test]
	fn wait_wakes_on_enqueue() {
		let sender = Sender::<Vec<u32>>::default();
		let receiver = sender.receiver();

		let (waker, w) = counting();
		let mut cx = Context::from_waker(&w);

		let mut recv = Box::pin(receiver.wait(nonempty));
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
	fn cleanup_fires_on_last_receiver() {
		// The hook rejects whatever is queued so nobody waits on undrained work.
		let sender = Sender::with_cleanup(Vec::<u32>::new(), |queue| queue.clear());
		let receiver = sender.receiver();
		let receiver2 = receiver.clone();

		sender.lock().push(1);
		sender.lock().push(2);

		// A non-last receiver dropping leaves the queue alone.
		drop(receiver2);
		assert_eq!(sender.read().len(), 2);

		// The last receiver dropping runs the cleanup under the lock.
		drop(receiver);
		assert!(sender.read().is_empty(), "cleanup should have drained the queue");
	}

	#[test]
	fn enqueue_gate_atomic_with_last_receiver_drop() {
		// The has_receivers check and the enqueue share one lock; the last-receiver cleanup
		// takes that same lock, so an item enqueued while a receiver still existed is rejected
		// rather than stranded.
		let sender = Sender::with_cleanup(Vec::<u32>::new(), |queue| queue.clear());
		let receiver = sender.receiver();

		let mut guard = sender.lock();
		assert!(guard.has_receivers());
		guard.push(9);
		drop(guard);

		drop(receiver);
		assert!(sender.read().is_empty(), "the queued item should have been rejected");
	}
}
