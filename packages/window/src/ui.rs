//! The window: omui's header bar over its one page, the conversation with the ghost.

use std::rc::Rc;

use gtk::prelude::*;

use crate::{api::Api, ask::AskPage};

pub struct App {
    pub api: Api,
    pub window: gtk::ApplicationWindow,
}

impl App {
    /// Builds the window and presents it. It lives as long as the application: its handlers hold it.
    pub fn build(app: &gtk::Application, api: Api) {
        let window = gtk::ApplicationWindow::builder().application(app).title("Ghost").default_width(1280).default_height(820).build();
        let title = omui::Title::new("Ghost", "");
        window.set_titlebar(Some(&omui::header(Some(title.widget.upcast_ref()))));

        let app = Rc::new(Self { api, window });
        let ask = AskPage::build(&app);
        app.window.set_child(Some(&ask.root));
        app.window.present();
        ask.focus();
    }
}
