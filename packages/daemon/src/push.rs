//! Alerts to the owner's devices when a turn ends (CONTRACTS.md "Push
//! alerts"): Web Push, sent by ghostd itself to the browser's push service.
//! summonghost.com has no backend, so nothing else could send them.
//!
//! A device that turns alerts on in the app hands this machine its push
//! subscription and a signing key the browser made for it. Each alert is
//! encrypted for that one browser (RFC 8291), signed with that key (VAPID,
//! RFC 8292), and posted with `curl`: ghostd has no TLS of its own.
use crate::env::Env;
use crate::log::Logger;
use crate::private_file::{read_text, write_json_atomic};
use crate::process::run_command;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use serde_json::{Value, json};
use sha2::Sha256;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// A device is a phone or a browser; an owner has a handful.
const MAX_SUBSCRIPTIONS: usize = 20;
const MAX_ENDPOINT_LENGTH: usize = 2_000;
/// How long a push service keeps an alert for a device that is offline.
const TTL_SECONDS: u32 = 86_400;
const SEND_TIMEOUT: Duration = Duration::from_secs(20);
/// Who a push service may write to about these alerts (RFC 8292 `sub`).
const CONTACT: &str = "https://summonghost.com";

/// The push services of the browsers the app runs in, by their domains
/// (Chrome's has been `fcm.googleapis.com` and `jmt17.google.com`). An
/// endpoint is a URL the app hands over, and ghostd posts to it: only a host
/// under one of these is posted to, never one on the owner's own network.
const PUSH_DOMAINS: [&str; 5] = [".googleapis.com", ".google.com", ".push.apple.com", ".mozilla.com", ".windows.com"];

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Unpadded base64url, as Web Push writes keys.
fn b64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..=chunk.len() {
            out.push(B64[((n >> (18 - 6 * index)) & 63) as usize] as char);
        }
    }
    out
}

/// The bytes of unpadded (or padded) base64url, or None when it is not that.
fn b64url_decode(text: &str) -> Option<Vec<u8>> {
    let text = text.trim_end_matches('=');
    if text.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut bits, mut count) = (0u32, 0u8);
    for byte in text.bytes() {
        let value = B64.iter().position(|known| *known == byte)? as u32;
        bits = (bits << 6) | value;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    Some(out)
}

/// One device's subscription: where its alerts go, the keys that encrypt
/// them for it, and the key its browser made to sign them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subscription {
    pub endpoint: String,
    /// The browser's public key, an uncompressed P-256 point (65 bytes).
    pub p256dh: Vec<u8>,
    /// The browser's authentication secret (16 bytes).
    pub auth: Vec<u8>,
    /// The signing key's private scalar (32 bytes).
    pub vapid: Vec<u8>,
}

/// The origin of a push endpoint ghostd will post to, or why it will not.
fn endpoint_origin(endpoint: &str) -> Result<String, String> {
    let refused = || "endpoint is not a known browser push service.".to_string();
    if endpoint.len() > MAX_ENDPOINT_LENGTH || endpoint.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(refused());
    }
    let rest = endpoint.strip_prefix("https://").ok_or_else(refused)?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    // No user, no port: a push service is its bare host.
    if authority.is_empty() || authority.contains(['@', ':']) {
        return Err(refused());
    }
    let host = authority.to_ascii_lowercase();
    let known = PUSH_DOMAINS.iter().any(|domain| host.ends_with(domain));
    if known { Ok(format!("https://{host}")) } else { Err(refused()) }
}

impl Subscription {
    /// A subscription as the app sends it: `{ endpoint, p256dh, auth, vapidKey }`, keys in base64url.
    pub fn parse(value: &Value) -> Result<Self, String> {
        let field = |name: &str| value.get(name).and_then(Value::as_str).ok_or_else(|| format!("{name} must be a string."));
        let bytes = |name: &str, length: usize| -> Result<Vec<u8>, String> {
            b64url_decode(field(name)?).filter(|bytes| bytes.len() == length).ok_or_else(|| format!("{name} must be {length} bytes of base64url."))
        };
        let endpoint = field("endpoint")?.to_string();
        endpoint_origin(&endpoint)?;
        let subscription = Self { endpoint, p256dh: bytes("p256dh", 65)?, auth: bytes("auth", 16)?, vapid: bytes("vapidKey", 32)? };
        PublicKey::from_sec1_bytes(&subscription.p256dh).map_err(|_| "p256dh is not a P-256 public key.".to_string())?;
        SecretKey::from_slice(&subscription.vapid).map_err(|_| "vapidKey is not a P-256 private key.".to_string())?;
        Ok(subscription)
    }

    fn to_json(&self) -> Value {
        json!({ "endpoint": self.endpoint, "p256dh": b64url(&self.p256dh), "auth": b64url(&self.auth), "vapidKey": b64url(&self.vapid) })
    }
}

fn expand(prk_salt: &[u8], ikm: &[u8], info: &[u8], length: usize) -> Vec<u8> {
    let mut out = vec![0u8; length];
    Hkdf::<Sha256>::new(Some(prk_salt), ikm).expand(info, &mut out).expect("a short HKDF output");
    out
}

/// `plaintext` as one `aes128gcm` record for the browser that holds
/// `p256dh` and `auth` (RFC 8291). `sender` is this message's own key and
/// `salt` its salt: fresh random ones for every message.
fn encrypt(p256dh: &[u8], auth: &[u8], plaintext: &[u8], sender: &[u8; 32], salt: &[u8; 16]) -> Result<Vec<u8>, String> {
    let receiver = PublicKey::from_sec1_bytes(p256dh).map_err(|_| "the device's key is not a P-256 public key".to_string())?;
    let sender = SecretKey::from_slice(sender).map_err(|_| "a sender key out of range".to_string())?;
    let sender_public = sender.public_key().to_encoded_point(false);
    let shared = p256::ecdh::diffie_hellman(sender.to_nonzero_scalar(), receiver.as_affine());

    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(receiver.to_encoded_point(false).as_bytes());
    key_info.extend_from_slice(sender_public.as_bytes());
    let ikm = expand(auth, shared.raw_secret_bytes(), &key_info, 32);
    let key = expand(salt, &ikm, b"Content-Encoding: aes128gcm\0", 16);
    let nonce: [u8; 12] = expand(salt, &ikm, b"Content-Encoding: nonce\0", 12).try_into().expect("12 bytes");

    // One record: the text, then the delimiter that marks it as the last.
    let mut record = plaintext.to_vec();
    record.push(2);
    let cipher = Aes128Gcm::new_from_slice(&key).expect("a 16-byte key");
    let sealed = cipher.encrypt(&Nonce::from(nonce), record.as_slice()).map_err(|_| "encryption failed".to_string())?;

    let mut body = salt.to_vec();
    body.extend_from_slice(&4096u32.to_be_bytes());
    body.push(sender_public.as_bytes().len() as u8);
    body.extend_from_slice(sender_public.as_bytes());
    body.extend_from_slice(&sealed);
    Ok(body)
}

/// The `Authorization` header that signs a push to `origin` with the
/// device's own key (RFC 8292): a 12-hour ES256 token and the public key.
fn vapid_authorization(origin: &str, vapid: &[u8], now_seconds: u64) -> Result<String, String> {
    let key = SigningKey::from_slice(vapid).map_err(|_| "the signing key is not a P-256 private key".to_string())?;
    let claims = json!({ "aud": origin, "exp": now_seconds + 12 * 3600, "sub": CONTACT });
    let signed = format!("{}.{}", b64url(br#"{"typ":"JWT","alg":"ES256"}"#), b64url(claims.to_string().as_bytes()));
    let signature: Signature = key.sign(signed.as_bytes());
    let public = key.verifying_key().to_encoded_point(false);
    Ok(format!("vapid t={signed}.{}, k={}", b64url(&signature.to_bytes()), b64url(public.as_bytes())))
}

/// What a push service said to one alert.
#[derive(Debug, PartialEq, Eq)]
pub enum Sent {
    Delivered,
    /// The device unsubscribed, or the subscription expired: it is dropped.
    Gone,
    Failed(String),
}

/// Encrypt, sign and post one alert to one device.
pub fn send(subscription: &Subscription, payload: &Value, env: &Env) -> Sent {
    let prepared = (|| -> Result<(Vec<u8>, String), String> {
        let origin = endpoint_origin(&subscription.endpoint)?;
        let body = encrypt(&subscription.p256dh, &subscription.auth, payload.to_string().as_bytes(), &fresh_key(), &crate::random::bytes::<16>())?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0);
        Ok((body, vapid_authorization(&origin, &subscription.vapid, now)?))
    })();
    let (body, authorization) = match prepared {
        Ok(prepared) => prepared,
        Err(message) => return Sent::Failed(message),
    };
    // curl reads the body from a private file: it is not text, so not stdin.
    let file = std::env::temp_dir().join(format!("ghost-push-{}", crate::random::uuid()));
    let posted = (|| -> Result<String, String> {
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut out = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&file).map_err(|error| error.to_string())?;
            out.write_all(&body).map_err(|error| error.to_string())?;
        }
        let data = format!("@{}", file.display());
        let (authorization, ttl) = (format!("Authorization: {authorization}"), format!("TTL: {TTL_SECONDS}"));
        let args = [
            "--silent",
            "--show-error",
            "--output",
            "/dev/null",
            "--write-out",
            "%{http_code}",
            "--max-time",
            "15",
            "--request",
            "POST",
            "--header",
            &authorization,
            "--header",
            &ttl,
            "--header",
            "Content-Encoding: aes128gcm",
            "--header",
            "Content-Type: application/octet-stream",
            "--header",
            "Urgency: normal",
            "--data-binary",
            &data,
            "--",
            &subscription.endpoint,
        ];
        match run_command("curl", &args, env, SEND_TIMEOUT) {
            Ok(result) => Ok(result.stdout.trim().to_string()),
            Err(crate::process::CommandFailure::Missing) => Err("curl is not installed".to_string()),
            Err(crate::process::CommandFailure::Other(message)) => Err(message),
        }
    })();
    let _ = std::fs::remove_file(&file);
    match posted.as_deref() {
        Ok("200" | "201" | "202" | "204") => Sent::Delivered,
        Ok("404" | "410") => Sent::Gone,
        Ok(status) => Sent::Failed(format!("the push service answered {status}")),
        Err(message) => Sent::Failed(message.to_string()),
    }
}

/// A private key for one message; the few values outside the curve's range are drawn again.
fn fresh_key() -> [u8; 32] {
    loop {
        let candidate = crate::random::bytes::<32>();
        if SecretKey::from_slice(&candidate).is_ok() {
            return candidate;
        }
    }
}

type Sender = dyn Fn(&Subscription, &Value) -> Sent + Send + Sync;

/// The devices that asked for alerts, kept in ghostd's own state (the file
/// holds their keys, so it is private), and the sending of one to all.
pub struct Push {
    path: PathBuf,
    logger: Logger,
    /// One change to the file at a time.
    lock: Mutex<()>,
    sender: Box<Sender>,
}

impl Push {
    pub fn new(path: PathBuf, logger: Logger, env: Env) -> Arc<Self> {
        Self::with_sender(path, logger, Box::new(move |subscription, payload| send(subscription, payload, &env)))
    }

    pub fn with_sender(path: PathBuf, logger: Logger, sender: Box<Sender>) -> Arc<Self> {
        Arc::new(Self { path, logger, lock: Mutex::new(()), sender })
    }

    /// `$XDG_STATE_HOME/ghost/push.json`, beside the API token.
    pub fn default_path(env: &Env, home: &Path) -> PathBuf {
        crate::xdg::base_dir(env, crate::xdg::Base::State, home).join("ghost").join("push.json")
    }

    fn read(&self) -> Vec<Subscription> {
        let text = read_text(&self.path).ok().flatten().unwrap_or_default();
        let document = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
        document["subscriptions"]
            .as_array()
            .map(|entries| entries.iter().filter_map(|entry| Subscription::parse(entry).ok()).collect())
            .unwrap_or_default()
    }

    fn write(&self, subscriptions: &[Subscription]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        if subscriptions.is_empty() {
            // Nothing to keep is no file, not an empty one.
            return match std::fs::remove_file(&self.path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
                _ => Ok(()),
            };
        }
        let entries: Vec<Value> = subscriptions.iter().map(Subscription::to_json).collect();
        write_json_atomic(&self.path, &json!({ "subscriptions": entries })).map_err(|error| error.to_string())
    }

    /// How many devices get alerts.
    pub fn count(&self) -> usize {
        self.read().len()
    }

    /// Add a device, or replace what was kept for its endpoint; the newest
    /// `MAX_SUBSCRIPTIONS` are kept.
    pub fn subscribe(&self, subscription: Subscription) -> Result<(), String> {
        let _held = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut kept: Vec<Subscription> = self.read().into_iter().filter(|known| known.endpoint != subscription.endpoint).collect();
        kept.push(subscription);
        let excess = kept.len().saturating_sub(MAX_SUBSCRIPTIONS);
        self.write(&kept[excess..])
    }

    /// Forget a device; true when it was known.
    pub fn unsubscribe(&self, endpoint: &str) -> Result<bool, String> {
        let _held = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let known = self.read();
        let kept: Vec<Subscription> = known.iter().filter(|subscription| subscription.endpoint != endpoint).cloned().collect();
        if kept.len() == known.len() {
            return Ok(false);
        }
        self.write(&kept).map(|()| true)
    }

    /// One alert to the device at `endpoint`, waited for: what the app sends
    /// when alerts are turned on, so the owner sees one arrive.
    pub fn test(&self, endpoint: &str, ghost: &str) -> Result<Sent, String> {
        let known = self.read().into_iter().find(|subscription| subscription.endpoint == endpoint);
        let subscription = known.ok_or_else(|| "That device is not subscribed here.".to_string())?;
        let sent =
            (self.sender)(&subscription, &json!({ "title": ghost, "body": "Alerts from this machine reach this device.", "url": Value::Null }));
        if sent == Sent::Gone {
            let _ = self.unsubscribe(endpoint);
        }
        Ok(sent)
    }

    /// Send `payload` to every device, and drop the ones their push service
    /// says are gone. It does not wait: a turn's end never waits on the network.
    pub fn notify(self: &Arc<Self>, payload: Value) {
        let subscriptions = self.read();
        if subscriptions.is_empty() {
            return;
        }
        let this = self.clone();
        std::thread::spawn(move || this.deliver(&subscriptions, &payload));
    }

    fn deliver(&self, subscriptions: &[Subscription], payload: &Value) {
        for subscription in subscriptions {
            match (self.sender)(subscription, payload) {
                Sent::Delivered => {}
                Sent::Gone => {
                    let _ = self.unsubscribe(&subscription.endpoint);
                }
                Sent::Failed(message) => self.logger.warn("a push alert was not delivered", json!({ "reason": message })),
            }
        }
    }
}

#[cfg(test)]
#[path = "push_tests.rs"]
mod tests;
