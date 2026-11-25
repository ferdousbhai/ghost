//! What the owner can connect (CONTRACTS.md "Connections"): each product
//! behind the sources, whether it is installed and signed in, and the
//! product's own command that installs or connects it. Ghost only reports and
//! names the command; a client runs it in a terminal the owner sees, because
//! every one of them asks the owner something (a password, a sign-in, a code).
use crate::env::which;
use crate::sources::{SourceContext, json, number_of, number_text, one_line_of, run_command};
use serde_json::{Map, Value};

/// A next step: a label and a shell command line for a terminal on the owner's desktop.
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionAction {
    pub label: String,
    pub command: String,
}

/// `Missing`: the product is not installed. `Disconnected`: installed, not signed in or set up.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ConnectionState {
    Missing,
    Disconnected,
    Connected,
}

impl ConnectionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Disconnected => "disconnected",
            Self::Connected => "connected",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Connection {
    pub id: &'static str,
    pub label: &'static str,
    /// What connecting it brings, in one line.
    pub brings: &'static str,
    pub state: ConnectionState,
    /// What is connected, or what is wrong, in one line; empty when there is nothing to say.
    pub detail: String,
    /// The next steps: installing when missing, else connecting or adding an account.
    pub actions: Vec<ConnectionAction>,
}

impl Connection {
    pub fn to_json(&self) -> Value {
        let actions: Value = self
            .actions
            .iter()
            .map(|action| {
                let mut map = Map::new();
                map.insert("label".into(), action.label.as_str().into());
                map.insert("command".into(), action.command.as_str().into());
                Value::Object(map)
            })
            .collect();
        let mut map = Map::new();
        map.insert("id".into(), self.id.into());
        map.insert("label".into(), self.label.into());
        map.insert("brings".into(), self.brings.into());
        map.insert("state".into(), self.state.as_str().into());
        map.insert("detail".into(), self.detail.as_str().into());
        map.insert("actions".into(), actions);
        Value::Object(map)
    }
}

/// Whether a product is connected, what to say about it, and what the owner can do next.
struct Probe {
    connected: bool,
    detail: String,
    actions: Vec<ConnectionAction>,
}

/// What installs a product.
enum Installer {
    /// The command the product catalog gives for it: the product's published
    /// installer (which adds its signed package repository), or a package manager's.
    Catalog,
    /// A command this table names itself.
    Fixed(&'static str),
}

struct Product {
    id: &'static str,
    label: &'static str,
    brings: &'static str,
    /// The command whose presence means installed.
    command: &'static str,
    installer: Installer,
    probe: fn(SourceContext) -> Probe,
}

/// The product catalog `ghost help products` also prints.
const CATALOG: &str = include_str!("products.json");

/// A product's install command, from the catalog. A product missing there is a mistake in this table.
fn installer(command: &str) -> String {
    let catalog: Value = serde_json::from_str(CATALOG).expect("products.json is JSON");
    let install = catalog["products"]
        .as_array()
        .and_then(|products| products.iter().find(|product| product["cli"] == command))
        .and_then(|product| product["install"].as_str())
        .filter(|install| !install.is_empty());
    match install {
        Some(install) => install.to_string(),
        None => panic!("no catalog install for {command}"),
    }
}

impl Product {
    fn install_command(&self) -> String {
        match self.installer {
            Installer::Catalog => installer(self.command),
            Installer::Fixed(command) => command.to_string(),
        }
    }
}

fn action(label: &str, command: &str) -> ConnectionAction {
    ConnectionAction { label: label.to_string(), command: command.to_string() }
}

/// What a product's status command printed, when that is a JSON object. Its exit code is not read: some print their state and exit 1.
fn status(command: &str, args: &[&str], context: SourceContext) -> Option<Value> {
    Some(json(&run_command(command, args, context, None).out)).filter(Value::is_object)
}

/// The accounts a product's status lists, as their labels, the unreachable ones marked. `ok` says whether an account still works.
fn accounts(value: Option<&Value>, ok: fn(&Value) -> bool) -> Vec<String> {
    let rows = value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    rows.iter()
        .map(|row| {
            let named = ["label", "name", "provider"].iter().find_map(|key| row.get(*key).filter(|value| !value.is_null()));
            let name = one_line_of(named, 60);
            if ok(row) { name } else { format!("{name} (needs sign-in)") }
        })
        .filter(|name| !name.is_empty())
        .collect()
}

fn add_account(command: &str, providers: &[&str]) -> Vec<ConnectionAction> {
    providers.iter().map(|name| action(&format!("Add {name}"), &format!("{command} account add {}", name.to_lowercase()))).collect()
}

fn probe_search(context: SourceContext) -> Probe {
    match status("recall", &["status"], context) {
        Some(state) => Probe {
            connected: true,
            detail: format!("{} of {} files searchable", number_text(number_of(state.get("searchable"))), number_text(number_of(state.get("files")))),
            actions: Vec::new(),
        },
        None => Probe { connected: false, detail: "Its service is not running.".into(), actions: vec![action("Set up", "recall setup")] },
    }
}

fn probe_icloud(context: SourceContext) -> Probe {
    let session = status("icloud-session", &["status", "--quiet"], context);
    let signed_in = session.as_ref().is_some_and(|session| session["signed_in"] == true);
    Probe {
        connected: signed_in,
        detail: if signed_in { one_line_of(session.as_ref().and_then(|session| session.get("apple_id")), 120) } else { String::new() },
        actions: if signed_in { Vec::new() } else { vec![action("Sign in", "icloud-session sign-in")] },
    }
}

fn probe_mail(context: SourceContext) -> Probe {
    let state = status("cloudmail", &["status", "--quiet"], context);
    let state = state.as_ref();
    let mut all = Vec::new();
    if state.and_then(|state| state["api_url"].as_str()).is_some_and(|url| !url.is_empty()) {
        all.push("your own domain".to_string());
    }
    all.extend(accounts(state.and_then(|state| state.get("accounts")), |row| row["ok"] != false));
    // `cloudmail init` asks at the terminal: an invite, your own domains (moving one to Cloudflare only after it asks), and the accounts to link.
    Probe {
        connected: !all.is_empty(),
        detail: all.join(", "),
        actions: vec![action(if all.is_empty() { "Set up mail" } else { "Add mail" }, "cloudmail init")],
    }
}

fn probe_calendar(context: SourceContext) -> Probe {
    let state = status("cloud-calendar", &["status", "--quiet"], context);
    let linked = accounts(state.as_ref().and_then(|state| state.get("accounts")), |row| row["ok"] != false);
    Probe { connected: !linked.is_empty(), detail: linked.join(", "), actions: add_account("cloud-calendar", &["iCloud", "Google", "HEY"]) }
}

fn probe_contacts(context: SourceContext) -> Probe {
    let state = status("cloud-contacts", &["status", "--quiet"], context);
    let linked = accounts(state.as_ref().and_then(|state| state.get("accounts")), |row| row["signed_in"] != false);
    Probe { connected: !linked.is_empty(), detail: linked.join(", "), actions: add_account("cloud-contacts", &["iCloud", "Google"]) }
}

fn probe_google(context: SourceContext) -> Probe {
    let session = status("google-session", &["status", "--quiet"], context).unwrap_or(Value::Null);
    let signed_in = session["signed_in"] == true;
    // `rejected`: Google refused the stored sign-in the last time a tool used it.
    let ended = signed_in && session["rejected"] == true;
    let working = signed_in && !ended;
    let email = one_line_of(session.get("email"), 120);
    Probe {
        connected: working,
        detail: if ended {
            format!("Google ended the sign-in of {email}.")
        } else if signed_in {
            email
        } else {
            String::new()
        },
        actions: if working { Vec::new() } else { vec![action(if ended { "Sign in again" } else { "Sign in" }, "google-session sign-in")] },
    }
}

fn probe_google_drive(context: SourceContext) -> Probe {
    let listed = json(&run_command("rclone", &["listremotes", "--type", "drive", "--json"], context, None).out);
    let remotes: Vec<String> = listed
        .as_array()
        .map(|remotes| remotes.iter().map(|remote| one_line_of(remote.get("name"), 60)).filter(|name| !name.is_empty()).collect())
        .unwrap_or_default();
    // rclone asks nothing at the terminal here but opens Google's sign-in in the browser.
    Probe {
        connected: !remotes.is_empty(),
        detail: remotes.join(", "),
        actions: if remotes.is_empty() { vec![action("Connect", "rclone config create gdrive drive scope=drive")] } else { Vec::new() },
    }
}

fn probe_google_workspace(context: SourceContext) -> Probe {
    let auth = status("gws", &["auth", "status"], context).unwrap_or(Value::Null);
    let working = auth["token_valid"] == true;
    let expired = !working && auth["has_refresh_token"] == true;
    // `gws auth setup` makes the owner's own Google Cloud client, once; `login` is the sign-in.
    let actions = if working {
        Vec::new()
    } else if auth["client_config_exists"] == true {
        vec![action(if expired { "Sign in again" } else { "Sign in" }, "gws auth login -s tasks,drive,docs,sheets,slides")]
    } else {
        vec![action("Set up", "gws auth setup")]
    };
    Probe { connected: working, detail: if expired { "The sign-in expired.".into() } else { String::new() }, actions }
}

fn probe_whatsapp(context: SourceContext) -> Probe {
    let doctor = status("wacli", &["doctor", "--json"], context).unwrap_or(Value::Null);
    let linked: Vec<String> = doctor["data"]["accounts"]
        .as_array()
        .map(|accounts| accounts.iter().filter(|account| account["linked"] == true).map(|account| one_line_of(account.get("account"), 60)).collect())
        .unwrap_or_default();
    // `wacli auth` shows the code to scan with the phone.
    Probe {
        connected: !linked.is_empty(),
        detail: linked.join(", "),
        actions: vec![action(if linked.is_empty() { "Link WhatsApp" } else { "Link another" }, "wacli auth")],
    }
}

fn probe_lastbook(_: SourceContext) -> Probe {
    Probe { connected: true, detail: String::new(), actions: Vec::new() }
}

const PRODUCTS: [Product; 10] = [
    Product {
        id: "search",
        label: "Search",
        brings: "Finds your files, notes and messages by meaning, with a model that runs on this computer.",
        command: "recall",
        installer: Installer::Catalog,
        probe: probe_search,
    },
    Product {
        id: "icloud",
        label: "iCloud",
        brings: "Notes, Reminders, Photos and iCloud Drive, synced with your Apple devices.",
        command: "icloud-session",
        installer: Installer::Catalog,
        probe: probe_icloud,
    },
    Product {
        id: "mail",
        label: "Mail",
        brings: "Mail on your own domain through Cloudflare, with Gmail, iCloud Mail and HEY alongside.",
        command: "cloudmail",
        installer: Installer::Catalog,
        probe: probe_mail,
    },
    Product {
        id: "calendar",
        label: "Calendar",
        brings: "iCloud, Google and HEY calendars as one agenda.",
        command: "cloud-calendar",
        installer: Installer::Catalog,
        probe: probe_calendar,
    },
    Product {
        id: "contacts",
        label: "Contacts",
        brings: "Your iCloud and Google contacts.",
        command: "cloud-contacts",
        installer: Installer::Catalog,
        probe: probe_contacts,
    },
    Product {
        id: "google",
        label: "Google Keep and Photos",
        brings: "Keep notes as files in Documents/Keep, and your Google Photos library.",
        command: "google-session",
        // No package yet: its README says how to build it.
        installer: Installer::Fixed("xdg-open https://github.com/ferdousbhai/google-for-omarchy#readme"),
        probe: probe_google,
    },
    Product {
        id: "google-drive",
        label: "Google Drive",
        brings: "Your Drive as the folder ~/Google Drive, kept in sync by rclone.",
        command: "rclone",
        installer: Installer::Fixed("omarchy pkg add rclone"),
        probe: probe_google_drive,
    },
    Product {
        id: "google-workspace",
        label: "Google Docs, Sheets and Tasks",
        brings: "Documents, spreadsheets and tasks, through Google's own command line.",
        command: "gws",
        installer: Installer::Catalog,
        probe: probe_google_workspace,
    },
    Product {
        id: "whatsapp",
        label: "WhatsApp",
        brings: "Your chats, saved as folders on this computer.",
        command: "wacli",
        installer: Installer::Catalog,
        probe: probe_whatsapp,
    },
    Product {
        id: "lastbook",
        label: "Lastbook",
        brings: "An offline library of manuals and references Ghost can cite.",
        command: "lastbook",
        installer: Installer::Catalog,
        probe: probe_lastbook,
    },
];

/// Every product, probed at once; one that fails to answer reads as not connected.
pub fn connections(context: SourceContext) -> Vec<Connection> {
    let one = |product: &Product| -> Connection {
        let (state, detail, actions) = if which(product.command, context.env).is_none() {
            (ConnectionState::Missing, String::new(), vec![action("Install", &product.install_command())])
        } else {
            let probe = (product.probe)(context);
            (if probe.connected { ConnectionState::Connected } else { ConnectionState::Disconnected }, probe.detail, probe.actions)
        };
        Connection { id: product.id, label: product.label, brings: product.brings, state, detail, actions }
    };
    std::thread::scope(|scope| {
        let probes: Vec<_> = PRODUCTS.iter().map(|product| (product, scope.spawn(move || one(product)))).collect();
        probes
            .into_iter()
            .map(|(product, probe)| {
                // A probe that could not finish reads as installed and not connected.
                probe.join().unwrap_or_else(|_| Connection {
                    id: product.id,
                    label: product.label,
                    brings: product.brings,
                    state: ConnectionState::Disconnected,
                    detail: String::new(),
                    actions: Vec::new(),
                })
            })
            .collect()
    })
}

/// Every product with its state and next steps: the array of `{ "connections": [...] }`.
pub fn list_connections(context: SourceContext) -> Value {
    connections(context).iter().map(Connection::to_json).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::testing::Owner;
    use serde_json::json as value;
    use std::time::{Duration, Instant};

    fn rows(owner: &Owner) -> Map<String, Value> {
        let listed = list_connections(owner.context());
        listed.as_array().unwrap().iter().map(|row| (row["id"].as_str().unwrap().to_string(), row.clone())).collect()
    }

    fn actions(pairs: &[(&str, &str)]) -> Value {
        pairs.iter().map(|(label, command)| value!({ "label": label, "command": command })).collect()
    }

    #[test]
    fn says_what_is_missing_what_is_signed_out_and_what_is_connected_with_the_products_own_next_step() {
        let owner = Owner::new(&[
            ("icloud-session", r#"printf '{"signed_in":false}'"#),
            (
                "cloud-calendar",
                r#"printf '{"accounts":[{"label":"Home","provider":"icloud","ok":true},{"label":"Work","provider":"google","ok":false}]}'"#,
            ),
            ("wacli", "exit 1"),
        ]);
        let rows = rows(&owner);
        assert_eq!(
            rows.keys().collect::<Vec<_>>(),
            ["search", "icloud", "mail", "calendar", "contacts", "google", "google-drive", "google-workspace", "whatsapp", "lastbook"]
        );
        assert_eq!(
            rows["mail"],
            value!({
                "id": "mail", "label": "Mail", "brings": "Mail on your own domain through Cloudflare, with Gmail, iCloud Mail and HEY alongside.",
                "state": "missing", "detail": "", "actions": [{ "label": "Install", "command": "curl -fsSL https://ferdousbhai.com/cloudmail/install.sh | sudo bash" }],
            })
        );
        assert_eq!((&rows["icloud"]["state"], &rows["icloud"]["detail"]), (&value!("disconnected"), &value!("")));
        assert_eq!(rows["icloud"]["actions"], actions(&[("Sign in", "icloud-session sign-in")]));
        assert_eq!((&rows["calendar"]["state"], &rows["calendar"]["detail"]), (&value!("connected"), &value!("Home, Work (needs sign-in)")));
        assert_eq!(
            rows["calendar"]["actions"],
            actions(&[
                ("Add iCloud", "cloud-calendar account add icloud"),
                ("Add Google", "cloud-calendar account add google"),
                ("Add HEY", "cloud-calendar account add hey")
            ])
        );
        assert_eq!(rows["whatsapp"]["state"], "disconnected");
        assert_eq!(rows["whatsapp"]["actions"], actions(&[("Link WhatsApp", "wacli auth")]));
        assert_eq!(rows["google"]["actions"], actions(&[("Install", "xdg-open https://github.com/ferdousbhai/google-for-omarchy#readme")]));
    }

    #[test]
    fn connects_google_through_its_own_tools_the_phone_sign_in_rclones_remote_and_gws() {
        let signed_out = Owner::new(&[
            ("google-session", r#"printf '{"signed_in":false}'; exit 1"#),
            ("rclone", r#"[ "$*" = "listremotes --type drive --json" ] && printf '[]'"#),
            (
                "gws",
                r#"echo 'Using keyring backend: keyring' >&2; printf '{"client_config_exists":true,"has_refresh_token":true,"token_valid":false}'"#,
            ),
        ]);
        let before = rows(&signed_out);
        assert_eq!(
            (&before["google"]["state"], &before["google"]["actions"]),
            (&value!("disconnected"), &actions(&[("Sign in", "google-session sign-in")]))
        );
        assert_eq!(
            (&before["google-drive"]["state"], &before["google-drive"]["actions"]),
            (&value!("disconnected"), &actions(&[("Connect", "rclone config create gdrive drive scope=drive")]))
        );
        assert_eq!(
            (&before["google-workspace"]["state"], &before["google-workspace"]["detail"]),
            (&value!("disconnected"), &value!("The sign-in expired."))
        );
        assert_eq!(before["google-workspace"]["actions"], actions(&[("Sign in again", "gws auth login -s tasks,drive,docs,sheets,slides")]));

        let signed_in = Owner::new(&[
            ("google-session", r#"printf '{"signed_in":true,"email":"me@example.com"}'"#),
            ("rclone", r#"printf '[{"name":"gdrive","type":"drive"}]'"#),
            ("gws", r#"printf '{"client_config_exists":true,"has_refresh_token":true,"token_valid":true}'"#),
        ]);
        let after = rows(&signed_in);
        for (id, detail) in [("google", "me@example.com"), ("google-drive", "gdrive"), ("google-workspace", "")] {
            assert_eq!(
                (&after[id]["state"], &after[id]["detail"], &after[id]["actions"]),
                (&value!("connected"), &value!(detail), &value!([])),
                "{id}"
            );
        }

        let ended = rows(&Owner::new(&[("google-session", r#"printf '{"signed_in":true,"email":"me@example.com","rejected":true}'; exit 1"#)]));
        assert_eq!(
            (&ended["google"]["state"], &ended["google"]["detail"], &ended["google"]["actions"]),
            (
                &value!("disconnected"),
                &value!("Google ended the sign-in of me@example.com."),
                &actions(&[("Sign in again", "google-session sign-in")])
            )
        );

        let bare = rows(&Owner::new(&[("gws", r#"printf '{"client_config_exists":false}'"#)]));
        assert_eq!(bare["google-workspace"]["actions"], actions(&[("Set up", "gws auth setup")]));
        assert_eq!(
            (&bare["google-drive"]["state"], &bare["google-drive"]["actions"]),
            (&value!("missing"), &actions(&[("Install", "omarchy pkg add rclone")]))
        );
    }

    #[test]
    fn names_the_accounts_each_connected_product_has() {
        let owner = Owner::new(&[
            ("recall", r#"[ "$*" = "status" ] && printf '{"searchable":120,"files":150}'"#),
            ("icloud-session", r#"printf '{"signed_in":true,"apple_id":"me@icloud.com"}'"#),
            ("cloudmail", r#"printf '{"api_url":"https://mail.example","accounts":[{"name":"Gmail"},{"provider":"hey","ok":false}]}'"#),
            ("cloud-contacts", r#"printf '{"accounts":[{"label":"iCloud","signed_in":true},{"label":"Google","signed_in":false}]}'"#),
            ("wacli", r#"printf '{"data":{"accounts":[{"account":"+1 555","linked":true},{"account":"+2","linked":false}]}}'"#),
            ("lastbook", "exit 3"),
        ]);
        let rows = rows(&owner);
        let told = |id: &str| (rows[id]["state"].as_str().unwrap().to_string(), rows[id]["detail"].as_str().unwrap().to_string());
        assert_eq!(told("search"), ("connected".into(), "120 of 150 files searchable".into()));
        assert_eq!(told("icloud"), ("connected".into(), "me@icloud.com".into()));
        assert_eq!(told("mail"), ("connected".into(), "your own domain, Gmail, hey (needs sign-in)".into()));
        assert_eq!(rows["mail"]["actions"], actions(&[("Add mail", "cloudmail init")]));
        assert_eq!(told("contacts"), ("connected".into(), "iCloud, Google (needs sign-in)".into()));
        assert_eq!(
            rows["contacts"]["actions"],
            actions(&[("Add iCloud", "cloud-contacts account add icloud"), ("Add Google", "cloud-contacts account add google")])
        );
        assert_eq!(told("whatsapp"), ("connected".into(), "+1 555".into()));
        assert_eq!(rows["whatsapp"]["actions"], actions(&[("Link another", "wacli auth")]));
        // Lastbook has no sign-in: installed is connected, and it is never run.
        assert_eq!((told("lastbook"), &rows["lastbook"]["actions"]), (("connected".into(), String::new()), &value!([])));

        // Installed products that say nothing useful read as not connected, each with its way in.
        let silent = Owner::new(&[("recall", "exit 1"), ("cloudmail", "printf '{}'"), ("cloud-contacts", "printf 'oops'")]);
        let rows = self::rows(&silent);
        assert_eq!((&rows["search"]["state"], &rows["search"]["detail"]), (&value!("disconnected"), &value!("Its service is not running.")));
        assert_eq!(rows["search"]["actions"], actions(&[("Set up", "recall setup")]));
        assert_eq!((&rows["mail"]["state"], &rows["mail"]["actions"]), (&value!("disconnected"), &actions(&[("Set up mail", "cloudmail init")])));
        assert_eq!(rows["contacts"]["state"], "disconnected");
    }

    #[test]
    fn every_product_that_installs_from_the_catalog_is_in_it() {
        let mut from_catalog = Vec::new();
        for product in &PRODUCTS {
            let command = product.install_command();
            assert!(!command.is_empty(), "{}", product.id);
            if matches!(product.installer, Installer::Catalog) {
                from_catalog.push(product.command);
            }
        }
        assert_eq!(from_catalog, ["recall", "icloud-session", "cloudmail", "cloud-calendar", "cloud-contacts", "gws", "wacli", "lastbook"]);
        assert_eq!(installer("recall"), "curl -fsSL https://ferdousbhai.com/recall/install.sh | sudo bash");
        assert_eq!(installer("gws"), "npm install -g @googleworkspace/cli");
        // With nothing installed, every row is its install command.
        let nothing = Owner::new(&[]);
        for (row, product) in connections(nothing.context()).iter().zip(&PRODUCTS) {
            assert_eq!(row.state, ConnectionState::Missing);
            assert_eq!(row.actions, [action("Install", &product.install_command())]);
        }
    }

    #[test]
    #[should_panic(expected = "no catalog install for no-such-product")]
    fn a_product_missing_from_the_catalog_is_a_mistake() {
        installer("no-such-product");
    }

    #[test]
    fn every_product_is_probed_at_once() {
        if !std::path::Path::new("/usr/bin/sleep").exists() {
            println!("skipped: /usr/bin/sleep is not installed");
            return;
        }
        let slow = "/usr/bin/sleep 1; printf '{}'";
        let owner = Owner::new(&[
            ("recall", slow),
            ("icloud-session", slow),
            ("cloudmail", slow),
            ("cloud-calendar", slow),
            ("cloud-contacts", slow),
            ("wacli", slow),
        ]);
        let started = Instant::now();
        assert_eq!(connections(owner.context()).len(), 10);
        assert!(started.elapsed() < Duration::from_millis(4000), "{:?}", started.elapsed());
    }
}
