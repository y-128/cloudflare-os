import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEV_PHOTOS_CREDENTIAL_KEY,
  getDevServerConfig,
  getInboxDevConfig,
  getPhotosDevConfig,
  getWranglerPortFromBackendHost,
} from "./dev-server-config.ts";

describe("getInboxDevConfig", () => {
  it("boots without a real domain or remote mail/AI while retaining administrator authentication", () => {
    const config = {
      name: "inbox", vars: { DOMAINS: "", EMAIL_ADDRESSES: "[]" },
      services: [{ binding: "WORKSHOP_AUTH", service: "workshop-backend" }],
      send_email: [{ name: "EMAIL", remote: true }], ai: { binding: "AI" },
    };
    const dev = getInboxDevConfig(config, {}, false);
    assert.equal(dev.vars?.DOMAINS, "inbox.test");
    assert.equal(dev.vars?.EMAIL_ADDRESSES, "[]");
    assert.deepEqual(dev.send_email, [{ name: "EMAIL", remote: false }]);
    assert.equal(dev.ai, undefined);
    assert.deepEqual(dev.services, config.services);
    assert.equal(config.send_email[0].remote, true);
  });

  it("honours explicit address configuration and the Workers AI opt-in", () => {
    const config = { vars: { DOMAINS: "configured.test", EMAIL_ADDRESSES: "[]" }, ai: { binding: "AI" } };
    const dev = getInboxDevConfig(config, { DOMAINS: "other.test", EMAIL_ADDRESSES: '["admin@other.test"]' }, true);
    assert.equal(dev.vars?.DOMAINS, "other.test");
    assert.equal(dev.vars?.EMAIL_ADDRESSES, '["admin@other.test"]');
    assert.deepEqual(dev.ai, config.ai);
    assert.equal(getInboxDevConfig(config, {}, false).vars?.DOMAINS, "configured.test");
  });
});

describe("getPhotosDevConfig", () => {
  it("boots with a well-formed key and direct sharing while retaining administrator authentication", () => {
    const config = {
      name: "photos", services: [{ binding: "WORKSHOP_AUTH", service: "workshop-backend" }],
    };
    const dev = getPhotosDevConfig(config, {});
    assert.equal(Buffer.from(String(dev.vars?.PHOTOS_CREDENTIAL_KEY), "base64").length, 32);
    assert.equal(dev.vars?.PHOTOS_CREDENTIAL_KEY, DEV_PHOTOS_CREDENTIAL_KEY);
    assert.equal(dev.vars?.PHOTOS_DIRECT_SHARE, "1");
    assert.deepEqual(dev.services, config.services);
    assert.equal(getPhotosDevConfig(config, { PHOTOS_CREDENTIAL_KEY: "k" }).vars?.PHOTOS_CREDENTIAL_KEY, "k");
  });
});

describe("getWranglerPortFromBackendHost", () => {
  it("extracts a port from a localhost backend host", () => {
    assert.equal(getWranglerPortFromBackendHost("localhost:9000"), "9000");
  });

  it("extracts a port from an IPv6 backend host", () => {
    assert.equal(getWranglerPortFromBackendHost("[::1]:9001"), "9001");
  });

  it("returns null when the backend host has no port", () => {
    assert.equal(getWranglerPortFromBackendHost("localhost"), null);
  });

  it("rejects invalid ports", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("localhost:99999"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects invalid IPv6 ports", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("[::1]:99999"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects port zero", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("localhost:0"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects invalid hosts", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("http://localhost:9000"),
        /VITE_BACKEND_HOST must include a valid host/);
  });
});

describe("getDevServerConfig", () => {
  it("uses VITE_BACKEND_HOST as the public host and Wrangler port", () => {
    assert.deepEqual(getDevServerConfig([], "localhost:9000"), {
      backendHost: "localhost:9000",
      wranglerPort: "9000",
    });
  });

  it("uses --port as the public host and Wrangler port", () => {
    assert.deepEqual(getDevServerConfig(["--port", "8899"]), {
      backendHost: "localhost:8899",
      wranglerPort: "8899",
    });
  });

  it("accepts --port=value", () => {
    assert.deepEqual(getDevServerConfig(["--port=8899"]), {
      backendHost: "localhost:8899",
      wranglerPort: "8899",
    });
  });

  for (const args of [["--port"], ["--port", "nope"], ["--port=0"], ["--port=65536"]]) {
    it(`rejects invalid arguments: ${args.join(" ")}`, () => {
      assert.throws(() => getDevServerConfig(args), /--port must be an integer between 1 and 65535/);
    });
  }
});
