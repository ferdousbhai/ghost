//! One stop signal shared by everything a turn or a request started: a flag
//! to poll, a wait that ends early, and callbacks that end what blocks (a
//! process group, a socket).
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

type Callback = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct State {
    aborted: bool,
    next: u64,
    callbacks: Vec<(u64, Callback)>,
}

#[derive(Clone, Default)]
pub struct Abort {
    state: Arc<(Mutex<State>, Condvar)>,
}

/// Unregisters its callback when dropped.
pub(crate) struct AbortGuard {
    abort: Abort,
    id: u64,
}

impl Drop for AbortGuard {
    fn drop(&mut self) {
        let mut state = self.abort.state.0.lock().unwrap();
        state.callbacks.retain(|(id, _)| *id != self.id);
    }
}

impl Abort {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_aborted(&self) -> bool {
        self.state.0.lock().unwrap().aborted
    }

    /// Set the flag once, wake every waiter, and run each registered callback.
    pub fn abort(&self) {
        let callbacks = {
            let mut state = self.state.0.lock().unwrap();
            if state.aborted {
                return;
            }
            state.aborted = true;
            std::mem::take(&mut state.callbacks)
        };
        self.state.1.notify_all();
        for (_, callback) in callbacks {
            callback();
        }
    }

    /// Run `callback` on abort, at once when already aborted. Dropping the
    /// guard withdraws it.
    pub(crate) fn on_abort(&self, callback: impl FnOnce() + Send + 'static) -> AbortGuard {
        let mut state = self.state.0.lock().unwrap();
        let id = state.next;
        state.next += 1;
        if state.aborted {
            drop(state);
            callback();
        } else {
            state.callbacks.push((id, Box::new(callback)));
        }
        AbortGuard { abort: self.clone(), id }
    }

    /// A signal that aborts when this one does, and can be aborted alone.
    pub(crate) fn child(&self) -> (Abort, AbortGuard) {
        let child = Abort::new();
        let linked = child.clone();
        let guard = self.on_abort(move || linked.abort());
        (child, guard)
    }

    /// Sleep up to `duration`; true when aborted before or during it.
    pub(crate) fn wait(&self, duration: Duration) -> bool {
        let state = self.state.0.lock().unwrap();
        let (state, _) = self.state.1.wait_timeout_while(state, duration, |state| !state.aborted).unwrap();
        state.aborted
    }
}
