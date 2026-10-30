import { describe, expect, it } from "vitest";
import { parseDesktopContext, redactTitle, renderDesktopContext } from "../src/desktop-context.js";

describe("desktop context", () => {
  it("parses the summon's window, dropping blank fields", () => {
    expect(parseDesktopContext(undefined)).toBeNull();
    expect(parseDesktopContext(null)).toBeNull();
    expect(parseDesktopContext({ app: " ", title: "" })).toBeNull();
    expect(parseDesktopContext({ app: "Alacritty", title: " vim notes.md ", cwd: "/home/owner/src" }))
      .toEqual({ app: "Alacritty", title: "vim notes.md", cwd: "/home/owner/src" });
  });

  it("refuses anything but the three bounded text fields", () => {
    for (const value of ["Alacritty", [], { app: 1 }, { pid: "42" }, { title: "x".repeat(1025) }]) {
      expect(() => parseDesktopContext(value), JSON.stringify(value)).toThrow(/desktop/u);
    }
  });

  it("blanks secrets a terminal title can show, and leaves ordinary titles alone", () => {
    expect(redactTitle("curl -H 'Authorization: Bearer sk-live-abc123' https://api.example.com"))
      .toBe("curl -H 'Authorization: Bearer [redacted]' https://api.example.com");
    expect(redactTitle("mysql --password=hunter2 -u root")).toBe("mysql --password=[redacted] -u root");
    expect(redactTitle("export GITHUB_TOKEN=ghp_abcdefghijklmnop")).toContain("[redacted]");
    expect(redactTitle("deploy ghp_0123456789abcdefghijABCDEFGHIJ0123")).toBe("deploy [redacted]");
    expect(redactTitle("~/src/ghost/packages/daemon/src/desktop-context.ts — nvim"))
      .toBe("~/src/ghost/packages/daemon/src/desktop-context.ts — nvim");
    expect(redactTitle("Inbox (3) - Chromium")).toBe("Inbox (3) - Chromium");
  });

  it("renders a hidden block naming the window, with the title redacted", () => {
    expect(renderDesktopContext({ app: "Alacritty", title: "psql password=s3cret", cwd: "/srv/app" })).toBe([
      "<desktop-context>",
      "The owner summoned you from this window; their message may be about it.",
      "app: Alacritty",
      "title: psql password=[redacted]",
      "terminal directory: /srv/app",
      "</desktop-context>",
    ].join("\n"));
  });
});
