import assert from "node:assert/strict";
import test from "node:test";
import {
  cookieKey,
  countSelectedCookies,
  getSelectedCookies,
  initSelectionFromCookieData,
  selectDomain,
  toggleCookie,
} from "./cookie-export-selection.ts";

// Selection logic only reads `name` and `path`, so a minimal cookie is enough.
function cookie(name, path, domain = "example.com") {
  return {
    name,
    value: "v",
    domain,
    path,
    expires: 0,
    is_secure: false,
    is_http_only: false,
    same_site: 0,
    creation_time: 0,
    last_accessed: 0,
  };
}

function readResult(domains) {
  const mapped = domains.map(([domain, cookies]) => ({
    domain,
    cookies,
    cookie_count: cookies.length,
  }));
  const total_count = mapped.reduce((n, d) => n + d.cookie_count, 0);
  return {
    profile_id: "p1",
    browser_type: "wayfern",
    domains: mapped,
    total_count,
  };
}

// The reported bug's scenario: a domain with two same-name cookies on
// different paths plus one distinct-name cookie.
const COL = readResult([
  [
    "example.com",
    [cookie("sid", "/"), cookie("sid", "/app"), cookie("uid", "/")],
  ],
]);

test("cookieKey distinguishes same-name cookies on different paths", () => {
  assert.equal(cookieKey({ name: "sid", path: "/" }), "sid\t/");
  assert.equal(cookieKey({ name: "sid", path: "/app" }), "sid\t/app");
  assert.notEqual(
    cookieKey({ name: "sid", path: "/" }),
    cookieKey({ name: "sid", path: "/app" }),
  );
});

test("initSelectionFromCookieData does not dedupe same-name rows", () => {
  const sel = initSelectionFromCookieData(COL);
  const ds = sel["example.com"];
  assert.equal(ds.allSelected, true);
  assert.equal(ds.cookies.size, 3);
  assert.ok(ds.cookies.has("sid\t/"));
  assert.ok(ds.cookies.has("sid\t/app"));
  assert.ok(ds.cookies.has("uid\t/"));
});

test("countSelectedCookies equals cookie_count when all selected", () => {
  const sel = initSelectionFromCookieData(COL);
  assert.equal(countSelectedCookies(COL, sel), 3);
  assert.equal(getSelectedCookies(COL, sel).length, 3);
});

test("toggling one same-name row affects only that row", () => {
  const initial = initSelectionFromCookieData(COL);
  // Uncheck the "sid" cookie on path "/" specifically.
  const after = toggleCookie(initial, "example.com", "sid", "/", 3);
  const ds = after["example.com"];
  assert.equal(ds.allSelected, false);
  assert.equal(ds.cookies.size, 2);
  assert.ok(!ds.cookies.has("sid\t/"));
  assert.ok(ds.cookies.has("sid\t/app"));
  assert.ok(ds.cookies.has("uid\t/"));
  // Counter must match the rows that will actually be exported.
  assert.equal(countSelectedCookies(COL, after), 2);
  assert.deepEqual(
    getSelectedCookies(COL, after).map((c) => `${c.name}@${c.path}`),
    ["sid@/app", "uid@/"],
  );
});

test("allSelected returns to true via per-row toggles even when names collide", () => {
  const initial = initSelectionFromCookieData(COL);
  const off = toggleCookie(initial, "example.com", "sid", "/", 3);
  assert.equal(off["example.com"].allSelected, false);
  const on = toggleCookie(off, "example.com", "sid", "/", 3);
  assert.equal(on["example.com"].allSelected, true);
  assert.equal(on["example.com"].cookies.size, 3);
  assert.equal(countSelectedCookies(COL, on), 3);
});

test("the counter never disagrees with the exported row count", () => {
  const initial = initSelectionFromCookieData(COL);
  const states = [initial];
  let s = initial;
  s = toggleCookie(s, "example.com", "sid", "/", 3);
  states.push(s);
  s = toggleCookie(s, "example.com", "uid", "/", 3);
  states.push(s);
  s = toggleCookie(s, "example.com", "sid", "/app", 3);
  states.push(s);
  s = toggleCookie(s, "example.com", "sid", "/", 3);
  states.push(s);
  for (const sel of states) {
    assert.equal(
      countSelectedCookies(COL, sel),
      getSelectedCookies(COL, sel).length,
    );
  }
});

test("deselecting the last cookie of a domain drops its entry", () => {
  const single = readResult([["a.com", [cookie("k", "/")]]]);
  const initial = initSelectionFromCookieData(single);
  const toggled = toggleCookie(initial, "a.com", "k", "/", 1);
  assert.equal(toggled["a.com"], undefined);
  assert.equal(countSelectedCookies(single, toggled), 0);
  const back = toggleCookie(toggled, "a.com", "k", "/", 1);
  assert.equal(back["a.com"].allSelected, true);
});

test("selectDomain toggles all/none and fills from partial", () => {
  const initial = initSelectionFromCookieData(COL);
  const none = selectDomain(initial, "example.com", COL.domains[0].cookies);
  assert.equal(none["example.com"], undefined);
  const all = selectDomain(none, "example.com", COL.domains[0].cookies);
  assert.equal(all["example.com"].allSelected, true);
  assert.equal(all["example.com"].cookies.size, 3);
  const partial = toggleCookie(initial, "example.com", "sid", "/", 3);
  assert.equal(partial["example.com"].allSelected, false);
  const re = selectDomain(partial, "example.com", COL.domains[0].cookies);
  assert.equal(re["example.com"].allSelected, true);
  assert.equal(re["example.com"].cookies.size, 3);
});

test("distinct-name domains keep their pre-existing behaviour", () => {
  const data = readResult([
    ["a.com", [cookie("x", "/"), cookie("y", "/")]],
    ["b.com", [cookie("z", "/")]],
  ]);
  const sel = initSelectionFromCookieData(data);
  assert.equal(countSelectedCookies(data, sel), 3);
  const one = toggleCookie(sel, "a.com", "x", "/", 2);
  assert.equal(countSelectedCookies(data, one), 2);
  assert.deepEqual(
    getSelectedCookies(data, one)
      .map((c) => c.name)
      .sort(),
    ["y", "z"],
  );
});

test("multiple domains sum counts and concatenate exported rows", () => {
  const data = readResult([
    ["a.com", [cookie("sid", "/", "a.com"), cookie("sid", "/app", "a.com")]],
    ["b.com", [cookie("sid", "/", "b.com"), cookie("other", "/", "b.com")]],
  ]);
  let sel = initSelectionFromCookieData(data);
  assert.equal(countSelectedCookies(data, sel), 4);
  sel = toggleCookie(sel, "a.com", "sid", "/", 2);
  assert.equal(countSelectedCookies(data, sel), 3);
  const exported = getSelectedCookies(data, sel);
  assert.equal(exported.length, 3);
  assert.deepEqual(
    exported.map((c) => `${c.domain}/${c.name}${c.path}`).sort(),
    ["a.com/sid/app", "b.com/other/", "b.com/sid/"],
  );
});

test("null cookie data reports zero selected and empty export", () => {
  assert.equal(countSelectedCookies(null, {}), 0);
  assert.deepEqual(getSelectedCookies(null, {}), []);
});
