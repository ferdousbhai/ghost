//! Test support: a scripted answerer that stands where the local model does,
//! for the conversation host's tests and the HTTP API's. No test loads a
//! model: each pass plays the next turn of a script and records what it was
//! given, so assertions are made against what a pass receives.
use crate::abort::Abort;
use crate::env::Env;
use crate::local_turn::{Answerer, PassEvent, PassInput};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// The bound on every wait: far longer than anything in a test takes, so reaching it is a failure, never a pace.
pub(crate) const WAIT: Duration = Duration::from_secs(30);

/// What has happened so far, and a wait for what has not happened yet.
pub(crate) struct Seen<T> {
    items: Mutex<Vec<T>>,
    changed: Condvar,
}

impl<T: Clone> Seen<T> {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self { items: Mutex::new(Vec::new()), changed: Condvar::new() })
    }

    /// Keep `item`; its position is returned.
    pub(crate) fn push(&self, item: T) -> usize {
        let mut items = self.items.lock().unwrap();
        items.push(item);
        self.changed.notify_all();
        items.len() - 1
    }

    pub(crate) fn all(&self) -> Vec<T> {
        self.items.lock().unwrap().clone()
    }

    /// Everything seen once `done` holds of it; a test that waits longer than `WAIT` fails.
    pub(crate) fn wait(&self, what: &str, done: impl Fn(&[T]) -> bool) -> Vec<T> {
        let items = self.items.lock().unwrap();
        let (items, timeout) = self.changed.wait_timeout_while(items, WAIT, |items| !done(items)).unwrap();
        assert!(!timeout.timed_out(), "timed out waiting for {what}");
        items.clone()
    }
}

/// Holds a scripted turn until it is released, or the turn is stopped, so
/// "the ghost is answering" is a state a test owns rather than a race it has
/// to win.
#[derive(Clone, Default)]
pub(crate) struct Gate(Arc<(Mutex<bool>, Condvar)>);

impl Gate {
    pub(crate) fn release(&self) {
        *self.0.0.lock().unwrap() = true;
        self.0.1.notify_all();
    }

    pub(crate) fn hold(&self, abort: &Abort) -> Result<(), String> {
        let waker = self.clone();
        let _woken = abort.on_abort(move || {
            let _held = waker.0.0.lock().unwrap();
            waker.0.1.notify_all();
        });
        let deadline = Instant::now() + 3 * WAIT;
        let mut open = self.0.0.lock().unwrap();
        while !*open {
            if abort.is_aborted() {
                return Err("stopped".to_string());
            }
            let left = deadline.checked_duration_since(Instant::now()).ok_or("the gate was never released")?;
            open = self.0.1.wait_timeout(open, left).unwrap().0;
        }
        Ok(())
    }
}

/// One turn of the fake, in the order turns are run.
#[derive(Clone, Default)]
pub(crate) struct FakeTurn {
    pub(crate) events: Vec<PassEvent>,
    /// Fail the pass after its events, with this message.
    pub(crate) fail: Option<String>,
    /// Hold the turn until this is released, or the turn is stopped.
    pub(crate) gate: Option<Gate>,
    /// Put this question and its answers to the owner, as the `ask` tool does.
    pub(crate) ask: Option<(String, Vec<String>)>,
}

/// What a pass was given; a completion has only its prompt.
#[derive(Clone, Debug)]
pub(crate) struct FakeCall {
    pub(crate) prompt: String,
    /// The conversation before it, as the chat messages the pass was handed.
    pub(crate) history: Vec<Value>,
    pub(crate) cwd: PathBuf,
    /// The environment its commands run with.
    pub(crate) env: Env,
    pub(crate) persona: String,
}

/// Call n plays entry n of the script, or its last.
pub(crate) struct Fake {
    script: Mutex<Vec<FakeTurn>>,
    calls: Arc<Seen<FakeCall>>,
    /// One for each held call that ended because its caller stopped it.
    stops: Arc<Seen<()>>,
}

impl Fake {
    pub(crate) fn new(turns: Vec<FakeTurn>) -> Arc<Self> {
        Arc::new(Self { script: Mutex::new(turns), calls: Seen::new(), stops: Seen::new() })
    }

    /// Add a turn to the end of the script.
    pub(crate) fn then(&self, turn: FakeTurn) {
        self.script.lock().unwrap().push(turn);
    }

    pub(crate) fn calls(&self) -> Vec<FakeCall> {
        self.calls.all()
    }

    pub(crate) fn prompts(&self) -> Vec<String> {
        self.calls().into_iter().map(|call| call.prompt).collect()
    }

    /// Wait until the fake has been asked `count` times.
    pub(crate) fn wait_for_calls(&self, count: usize) {
        self.calls.wait(&format!("call {count} of the answerer"), |calls| calls.len() >= count);
    }

    /// Wait until a held call has been stopped.
    pub(crate) fn wait_for_a_stop(&self) {
        self.stops.wait("a call to be stopped", |stops| !stops.is_empty());
    }

    /// Record a call and take its turn, held while its gate is.
    fn enter(&self, call: FakeCall, abort: &Abort) -> Result<FakeTurn, String> {
        let n = self.calls.push(call);
        let turn = {
            let script = self.script.lock().unwrap();
            script.get(n.min(script.len().saturating_sub(1))).cloned().unwrap_or_default()
        };
        if let Some(gate) = &turn.gate {
            gate.hold(abort).inspect_err(|_| {
                if abort.is_aborted() {
                    self.stops.push(());
                }
            })?;
        }
        Ok(turn)
    }
}

impl Answerer for Fake {
    fn turn(&self, input: &PassInput, on_event: &mut dyn FnMut(PassEvent)) -> Result<(), String> {
        let call = FakeCall {
            prompt: input.prompt.clone(),
            history: input.history.clone(),
            cwd: input.cwd.clone(),
            env: input.env.clone(),
            persona: input.persona.clone(),
        };
        let turn = self.enter(call, &input.abort)?;
        if let Some((question, options)) = &turn.ask {
            (input.ask)(question, options)?;
        }
        for event in turn.events {
            on_event(event);
        }
        turn.fail.map_or(Ok(()), Err)
    }

    fn complete(&self, prompt: &str, abort: &Abort) -> Result<String, String> {
        let call = FakeCall { prompt: prompt.to_string(), history: Vec::new(), cwd: PathBuf::new(), env: Env::new(), persona: String::new() };
        let turn = self.enter(call, abort)?;
        if let Some(failure) = turn.fail {
            return Err(failure);
        }
        Ok(turn.events.iter().filter_map(|event| if let PassEvent::Text { delta, .. } = event { Some(delta.as_str()) } else { None }).collect())
    }
}

pub(crate) fn said(block: &str, delta: &str) -> PassEvent {
    PassEvent::Text { block: block.to_string(), delta: delta.to_string() }
}

/// A turn that says `text`.
pub(crate) fn says(text: &str) -> FakeTurn {
    FakeTurn { events: vec![said("a", text)], ..Default::default() }
}

/// Turns for the common case: each string is one reply.
pub(crate) fn replies(texts: &[&str]) -> Vec<FakeTurn> {
    texts.iter().map(|text| says(text)).collect()
}
