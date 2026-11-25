use super::*;
use std::sync::Mutex as StdMutex;

fn bytes(text: &str) -> Vec<u8> {
    b64url_decode(text).unwrap()
}

// RFC 8291, section 5 and appendix A: the inputs, and the message they must produce.
const UA_PUBLIC: &str = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
const AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";

#[test]
fn encrypts_the_standards_own_example_to_the_bytes_it_gives() {
    let body = encrypt(
        &bytes(UA_PUBLIC),
        &bytes(AUTH),
        b"When I grow up, I want to be a watermelon",
        &bytes(AS_PRIVATE).try_into().unwrap(),
        &bytes(SALT).try_into().unwrap(),
    )
    .unwrap();
    let expected = concat!(
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml",
        "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT",
        "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
    assert_eq!(b64url(&body), expected);
}

#[test]
fn base64url_round_trips_every_length_and_refuses_what_is_not_it() {
    for length in 0..40usize {
        let data: Vec<u8> = (0..length).map(|index| (index * 37 + 11) as u8).collect();
        assert_eq!(b64url_decode(&b64url(&data)), Some(data));
    }
    assert_eq!(b64url(b"\xfb\xff"), "-_8");
    assert_eq!(b64url_decode("-_8="), Some(vec![0xfb, 0xff]));
    assert_eq!(b64url_decode("a"), None);
    assert_eq!(b64url_decode("a+b/"), None);
}

#[test]
fn the_signature_is_a_token_the_devices_own_key_verifies() {
    use p256::ecdsa::signature::Verifier;
    let vapid = bytes(AS_PRIVATE);
    let header = vapid_authorization("https://fcm.googleapis.com", &vapid, 1_800_000_000).unwrap();
    let (token, key) = header.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(parts.len(), 3);
    assert_eq!(String::from_utf8(bytes(parts[0])).unwrap(), r#"{"typ":"JWT","alg":"ES256"}"#);
    let claims: Value = serde_json::from_slice(&bytes(parts[1])).unwrap();
    assert_eq!(claims, json!({ "aud": "https://fcm.googleapis.com", "exp": 1_800_043_200u64, "sub": "https://summonghost.com" }));
    // The public key sent is the one that made the signature.
    let public = p256::ecdsa::VerifyingKey::from_sec1_bytes(&bytes(key)).unwrap();
    let signature = Signature::from_slice(&bytes(parts[2])).unwrap();
    public.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature).unwrap();
    assert_eq!(key, "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
}

#[test]
fn only_a_browsers_push_service_over_https_is_an_endpoint() {
    for (endpoint, origin) in [
        ("https://fcm.googleapis.com/fcm/send/abc:def", "https://fcm.googleapis.com"),
        ("https://jmt17.google.com/fcm/send/abc:def", "https://jmt17.google.com"),
        ("https://web.push.apple.com/QGX", "https://web.push.apple.com"),
        ("https://updates.push.services.mozilla.com/wpush/v2/x", "https://updates.push.services.mozilla.com"),
        ("https://DB5P.notify.windows.com/w/?token=x", "https://db5p.notify.windows.com"),
    ] {
        assert_eq!(endpoint_origin(endpoint), Ok(origin.to_string()), "{endpoint}");
    }
    for refused in [
        "http://fcm.googleapis.com/fcm/send/x",
        "https://example.com/push",
        "https://fcm.googleapis.com.evil.example/x",
        "https://evilpush.apple.com/x",
        "https://notgoogle.com/x",
        "https://google.com.evil.example/x",
        "https://192.168.1.10/x",
        "https://user@fcm.googleapis.com/x",
        "https://fcm.googleapis.com:8443/x",
        "https://127.0.0.1/x",
        "https://fcm.googleapis.com/a b",
        "",
    ] {
        assert!(endpoint_origin(refused).is_err(), "{refused}");
    }
}

fn subscription(endpoint: &str) -> Subscription {
    Subscription::parse(&json!({ "endpoint": endpoint, "p256dh": UA_PUBLIC, "auth": AUTH, "vapidKey": AS_PRIVATE })).unwrap()
}

#[test]
fn a_subscription_needs_a_known_endpoint_and_keys_of_the_right_kind() {
    let good = json!({ "endpoint": "https://fcm.googleapis.com/fcm/send/a", "p256dh": UA_PUBLIC, "auth": AUTH, "vapidKey": AS_PRIVATE });
    assert!(Subscription::parse(&good).is_ok());
    for (field, value) in [
        ("endpoint", json!("https://example.com/x")),
        ("endpoint", json!(7)),
        ("p256dh", json!(AUTH)),
        // 65 bytes that are not a point on the curve.
        ("p256dh", json!(b64url(&[4u8; 65]))),
        ("auth", json!("short")),
        ("vapidKey", json!(b64url(&[0u8; 32]))),
        ("vapidKey", Value::Null),
    ] {
        let mut bad = good.clone();
        bad[field] = value.clone();
        assert!(Subscription::parse(&bad).is_err(), "{field} = {value}");
    }
}

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("ghost-push-test-{}", crate::random::uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn devices_are_kept_privately_replaced_by_endpoint_and_dropped_when_their_service_says_gone() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new();
    let path = scratch.0.join("state").join("push.json");
    let sent: Arc<StdMutex<Vec<(String, Value)>>> = Arc::default();
    let seen = sent.clone();
    let push = Push::with_sender(
        path.clone(),
        Logger::silent(),
        Box::new(move |subscription, payload| {
            seen.lock().unwrap().push((subscription.endpoint.clone(), payload.clone()));
            if subscription.endpoint.ends_with("/gone") {
                Sent::Gone
            } else if subscription.endpoint.ends_with("/down") {
                Sent::Failed("offline".into())
            } else {
                Sent::Delivered
            }
        }),
    );
    assert_eq!(push.count(), 0);
    assert!(!path.exists());
    for name in ["phone", "gone", "down", "phone"] {
        push.subscribe(subscription(&format!("https://fcm.googleapis.com/fcm/send/{name}"))).unwrap();
    }
    assert_eq!(push.count(), 3);
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);

    push.deliver(&push.read(), &json!({ "title": "Boat" }));
    let endpoints: Vec<String> = sent.lock().unwrap().iter().map(|(endpoint, _)| endpoint.rsplit('/').next().unwrap().to_string()).collect();
    assert_eq!(endpoints, ["gone", "down", "phone"]);
    assert!(sent.lock().unwrap().iter().all(|(_, payload)| payload == &json!({ "title": "Boat" })));
    // Gone is forgotten; a failure is only a failure.
    let kept: Vec<String> = push.read().iter().map(|known| known.endpoint.rsplit('/').next().unwrap().to_string()).collect();
    assert_eq!(kept, ["down", "phone"]);

    assert_eq!(push.unsubscribe("https://fcm.googleapis.com/fcm/send/nobody"), Ok(false));
    assert_eq!(push.unsubscribe("https://fcm.googleapis.com/fcm/send/down"), Ok(true));
    assert_eq!(push.unsubscribe("https://fcm.googleapis.com/fcm/send/phone"), Ok(true));
    assert!(!path.exists());
}

#[test]
fn only_the_newest_devices_are_kept() {
    let scratch = Scratch::new();
    let push = Push::with_sender(scratch.0.join("push.json"), Logger::silent(), Box::new(|_, _| Sent::Delivered));
    for index in 0..MAX_SUBSCRIPTIONS + 3 {
        push.subscribe(subscription(&format!("https://fcm.googleapis.com/fcm/send/{index}"))).unwrap();
    }
    let kept = push.read();
    assert_eq!(kept.len(), MAX_SUBSCRIPTIONS);
    assert!(kept[0].endpoint.ends_with("/3"));
}
