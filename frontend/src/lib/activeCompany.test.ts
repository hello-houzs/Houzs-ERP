import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_TOKEN_KEY, authSessionFingerprint, writeAuthToken } from "./authToken";
import {
  ACTIVE_COMPANY_KEY,
  companyHeader,
  getActiveCompanyId,
  setActiveCompanyId,
  subscribeActiveCompany,
} from "./activeCompany";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("active company session scope", () => {
  it("does not send an unscoped legacy company before authentication", () => {
    localStorage.setItem(ACTIVE_COMPANY_KEY, "99");
    expect(getActiveCompanyId()).toBeNull();
    expect(companyHeader()).toEqual({});
  });

  it("stores and reads the company only under the effective session", () => {
    writeAuthToken("user-one-session", true);
    const firstScope = authSessionFingerprint();
    setActiveCompanyId(7);
    expect(localStorage.getItem(`${ACTIVE_COMPANY_KEY}:${firstScope}`)).toBe("7");
    expect(companyHeader()).toEqual({ "X-Company-Id": "7" });

    writeAuthToken("user-two-session", true);
    expect(getActiveCompanyId()).toBeNull();
    setActiveCompanyId(8);
    expect(companyHeader()).toEqual({ "X-Company-Id": "8" });

    writeAuthToken("user-one-session", true);
    expect(getActiveCompanyId()).toBe(7);
  });

  it("ignores another session's company storage event", () => {
    writeAuthToken("current-session", true);
    const listener = vi.fn();
    const unsubscribe = subscribeActiveCompany(listener);

    window.dispatchEvent(new StorageEvent("storage", {
      key: `${ACTIVE_COMPANY_KEY}:another-session`,
      oldValue: "1",
      newValue: "2",
      storageArea: localStorage,
    }));
    expect(listener).not.toHaveBeenCalled();

    const key = `${ACTIVE_COMPANY_KEY}:${authSessionFingerprint()}`;
    window.dispatchEvent(new StorageEvent("storage", {
      key,
      oldValue: "1",
      newValue: "2",
      storageArea: localStorage,
    }));
    expect(listener).toHaveBeenCalledWith("storage");
    unsubscribe();
  });

  it("keeps tab-only sessions on independent company keys", () => {
    localStorage.setItem(AUTH_TOKEN_KEY, "remembered-session");
    writeAuthToken("tab-session", false);
    setActiveCompanyId(12);
    const tabKey = `${ACTIVE_COMPANY_KEY}:${authSessionFingerprint()}`;

    expect(localStorage.getItem(tabKey)).toBe("12");
    expect(localStorage.getItem(ACTIVE_COMPANY_KEY)).toBeNull();
  });
});
