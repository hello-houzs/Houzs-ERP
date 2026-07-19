import { describe, expect, it } from "vitest";
import {
  LANG_LABELS,
  LANG_SUBLABELS,
  MOBILE_LANGS,
  localizeAnnouncement,
  type MobileLang,
} from "./mobileI18n";

describe("MOBILE_LANGS", () => {
  it("is exactly English, Malay, Chinese, Bengali", () => {
    expect([...MOBILE_LANGS]).toEqual(["en", "ms", "zh", "bn"]);
  });

  // Guard the owner's 2026-07-17 ruling: Hookka's 4th language is Burmese,
  // Houzs's is Bengali. A copy-paste from the Hookka portal would reintroduce
  // "my" — fail loudly if it ever does.
  it("has no Burmese anywhere", () => {
    expect(MOBILE_LANGS as readonly string[]).not.toContain("my");
  });

  it("labels every language in its own script, with an English gloss", () => {
    for (const l of MOBILE_LANGS) {
      expect(LANG_LABELS[l]).toBeTruthy();
      expect(LANG_SUBLABELS[l]).toBeTruthy();
    }
    expect(LANG_LABELS.bn).toBe("বাংলা");
    expect(LANG_SUBLABELS.bn).toBe("Bengali (Bangladesh)");
  });
});

describe("localizeAnnouncement", () => {
  const base = { title: "Holiday notice", body: "Office closed 05/08/2026." };
  const bnPair = { title: "ছুটির বিজ্ঞপ্তি", body: "অফিস বন্ধ ০৫/০৮/২০২৬।" };

  it("returns the Bengali translation when one exists", () => {
    const r = localizeAnnouncement({ ...base, translations: { bn: bnPair } }, "bn");
    expect(r.title).toBe(bnPair.title);
    expect(r.body).toBe(bnPair.body);
    expect(r.isTranslated).toBe(true);
  });

  // The core promise: a reader NEVER sees a blank, and never sees a key.
  it("falls back to the original when the chosen language is missing", () => {
    for (const t of [undefined, null, {}, { zh: { title: "x", body: "y" } }]) {
      const r = localizeAnnouncement({ ...base, translations: t as never }, "bn");
      expect(r.title).toBe(base.title);
      expect(r.body).toBe(base.body);
      expect(r.isTranslated).toBe(false);
    }
  });

  // Rows written while the 4th language was still Burmese carry a "my" key and
  // no "bn". They must degrade to the original, not to Burmese and not to "".
  it("ignores a legacy Burmese blob rather than showing it", () => {
    const legacy = { translations: { my: { title: "မြန်မာ", body: "စာ" } } as never };
    const r = localizeAnnouncement({ ...base, ...legacy }, "bn");
    expect(r.title).toBe(base.title);
    expect(r.isTranslated).toBe(false);
  });

  it("never yields an empty string for a non-empty original", () => {
    const blanks = [
      { bn: { title: "", body: "" } },
      { bn: { title: "   ", body: "   " } },
      { bn: { title: bnPair.title, body: "" } }, // half-translated
    ];
    for (const t of blanks) {
      const r = localizeAnnouncement({ ...base, translations: t }, "bn");
      expect(r.title.trim()).not.toBe("");
      expect(r.body.trim()).not.toBe("");
      expect(r.isTranslated).toBe(false);
    }
  });

  // A headline-only notice is legitimate; demanding a translated body would
  // wrongly mark those as untranslated forever.
  it("accepts a translated title when the original body is empty", () => {
    const r = localizeAnnouncement(
      { title: base.title, body: "", translations: { bn: { title: bnPair.title, body: "" } } },
      "bn",
    );
    expect(r.title).toBe(bnPair.title);
    expect(r.isTranslated).toBe(true);
  });

  it("gives English readers the author's original text", () => {
    const r = localizeAnnouncement(
      { ...base, translations: { en: { title: "Round-tripped", body: "Round-tripped" } } },
      "en",
    );
    expect(r.title).toBe(base.title);
    expect(r.isTranslated).toBe(false);
  });

  it("resolves every supported language without throwing", () => {
    for (const l of MOBILE_LANGS as readonly MobileLang[]) {
      expect(() => localizeAnnouncement(base, l)).not.toThrow();
      expect(localizeAnnouncement(base, l).title).toBe(base.title);
    }
  });
});
