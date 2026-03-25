"use client";

import { useEffect, useState } from "react";
import { apiFetch, getClientAuthToken, setClientAuthToken } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ApiError, errText as errTextShared } from "@/lib/apiError";
import { Badge, Card, PageHeader } from "@/components/ui";

function errMsg(e: unknown) {
  if (e instanceof Error) return e.message;
  return String(e);
}

function parseErr(json: unknown, locale: string) {
  const o = json && typeof json === "object" ? (json as ApiError) : {};
  return errTextShared(locale, o) || "ERROR";
}

export default function SettingsClient(props: { locale: string }) {
  const [authToken, setAuthToken] = useState<string>(() => getClientAuthToken());
  const [authTokenStatus, setAuthTokenStatus] = useState<"unset" | "set">(() => (getClientAuthToken() ? "set" : "unset"));

  /* NL2UI Style Preferences */
  const [nl2uiFontSize, setNl2uiFontSize] = useState<string>("medium");
  const [nl2uiCardStyle, setNl2uiCardStyle] = useState<string>("modern");
  const [nl2uiColorTheme, setNl2uiColorTheme] = useState<string>("blue");
  const [nl2uiDensity, setNl2uiDensity] = useState<string>("comfortable");
  const [nl2uiDefaultLayout, setNl2uiDefaultLayout] = useState<string>("list");
  const [nl2uiPrefsStatus, setNl2uiPrefsStatus] = useState<string>("idle");
  const [nl2uiPrefsErr, setNl2uiPrefsErr] = useState<string>("");

  const [consoleErr, setConsoleErr] = useState<string>("");


  function statusText(v: string) {
    const key = `status.${v}`;
    const out = t(props.locale, key);
    return out === key ? v : out;
  }

  function saveToken() {
    const v = authToken.trim();
    setClientAuthToken(v);
    setAuthToken(v);
    setAuthTokenStatus(v ? "set" : "unset");
    setConsoleErr("");
  }

  function clearToken() {
    setClientAuthToken("");
    setAuthToken("");
    setAuthTokenStatus("unset");
    setConsoleErr("");
  }

  function generateCredential() {
    // Generate a secure credential with UUID-like random ID
    // Format: dev:user_<timestamp>_<random> to ensure uniqueness
    const timestamp = Date.now().toString(36);
    const randomPart = crypto.randomUUID().replace(/-/g, "").substring(0, 12);
    const generated = `dev:user_${timestamp}_${randomPart}`;
    setAuthToken(generated);
    setClientAuthToken(generated);
    setAuthTokenStatus("set");
    setConsoleErr("");
  }

  /* ─── NL2UI Style Preferences ─── */

  async function loadNl2uiPrefs() {
    setNl2uiPrefsErr("");
    setNl2uiPrefsStatus("loading");
    try {
      const res = await apiFetch("/nl2ui/style-preferences", { method: "GET", locale: props.locale });
      if (res.ok) {
        const data = await res.json() as { preferences: any };
        if (data.preferences) {
          setNl2uiFontSize(data.preferences.fontSize || "medium");
          setNl2uiCardStyle(data.preferences.cardStyle || "modern");
          setNl2uiColorTheme(data.preferences.colorTheme || "blue");
          setNl2uiDensity(data.preferences.density || "comfortable");
          setNl2uiDefaultLayout(data.preferences.defaultLayout || "list");
        }
        setNl2uiPrefsStatus("ready");
      } else {
        setNl2uiPrefsStatus("idle");
        setNl2uiPrefsErr(parseErr(await res.json().catch(() => null), props.locale));
      }
    } catch (e: unknown) {
      setNl2uiPrefsStatus("idle");
      setNl2uiPrefsErr(errMsg(e));
    }
  }

  async function saveNl2uiPrefs() {
    setNl2uiPrefsErr("");
    setNl2uiPrefsStatus("saving");
    try {
      const res = await apiFetch("/nl2ui/style-preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          fontSize: nl2uiFontSize,
          cardStyle: nl2uiCardStyle,
          colorTheme: nl2uiColorTheme,
          density: nl2uiDensity,
          defaultLayout: nl2uiDefaultLayout,
        }),
      });
      if (res.ok) {
        setNl2uiPrefsStatus("saved");
        setTimeout(() => setNl2uiPrefsStatus("ready"), 1500);
      } else {
        setNl2uiPrefsStatus("ready");
        setNl2uiPrefsErr(parseErr(await res.json().catch(() => null), props.locale));
      }
    } catch (e: unknown) {
      setNl2uiPrefsStatus("ready");
      setNl2uiPrefsErr(errMsg(e));
    }
  }

  async function clearNl2uiPrefs() {
    setNl2uiPrefsErr("");
    try {
      await apiFetch("/nl2ui/style-preferences", { method: "DELETE", locale: props.locale });
      setNl2uiFontSize("medium");
      setNl2uiCardStyle("modern");
      setNl2uiColorTheme("blue");
      setNl2uiDensity("comfortable");
      setNl2uiDefaultLayout("list");
      setNl2uiPrefsStatus("idle");
    } catch (e: unknown) {
      setNl2uiPrefsErr(errMsg(e));
    }
  }

  /* auto-load NL2UI prefs on mount when token is present */
  useEffect(() => {
    if (getClientAuthToken()) loadNl2uiPrefs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "settings.title")}
      />
      {consoleErr ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{consoleErr}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card
          title={t(props.locale, "settings.section.auth")}
          footer={
            <span>
              {t(props.locale, "settings.auth.hint")}
              {" · "}
              <Badge tone={authTokenStatus === "set" ? "success" : "warning"}>{statusText(authTokenStatus)}</Badge>
            </span>
          }
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span>{t(props.locale, "settings.auth.tokenLabel")}</span>
            <input
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              placeholder={t(props.locale, "settings.auth.tokenPlaceholder")}
              style={{ width: 520 }}
            />
            <button onClick={generateCredential}>{t(props.locale, "settings.auth.generate")}</button>
            <button onClick={saveToken}>{t(props.locale, "action.save")}</button>
            <button onClick={clearToken}>{t(props.locale, "action.clear")}</button>
          </div>
        </Card>
      </div>

      {/* NL2UI style preferences */}
      <div style={{ marginTop: 16 }} id="nl2ui-prefs">
        <Card
          title={t(props.locale, "settings.section.nl2uiPrefs")}
          footer={
            <span>
              <Badge tone={nl2uiPrefsStatus === "saved" ? "success" : nl2uiPrefsStatus === "ready" ? "neutral" : "warning"}>
                {nl2uiPrefsStatus === "saved" ? t(props.locale, "action.saved") : statusText(nl2uiPrefsStatus)}
              </Badge>
            </span>
          }
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <button onClick={loadNl2uiPrefs} disabled={nl2uiPrefsStatus === "loading"}>
              {nl2uiPrefsStatus === "loading" ? t(props.locale, "action.loading") : t(props.locale, "action.load")}
            </button>
          </div>
          {nl2uiPrefsErr && <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginBottom: 12 }}>{nl2uiPrefsErr}</pre>}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16, marginBottom: 16 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "nl2ui.prefs.fontSize")}</span>
              <select value={nl2uiFontSize} onChange={(e) => setNl2uiFontSize(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6 }}>
                <option value="small">{t(props.locale, "nl2ui.prefs.fontSize.small")}</option>
                <option value="medium">{t(props.locale, "nl2ui.prefs.fontSize.medium")}</option>
                <option value="large">{t(props.locale, "nl2ui.prefs.fontSize.large")}</option>
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "nl2ui.prefs.cardStyle")}</span>
              <select value={nl2uiCardStyle} onChange={(e) => setNl2uiCardStyle(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6 }}>
                <option value="minimal">{t(props.locale, "nl2ui.prefs.cardStyle.minimal")}</option>
                <option value="modern">{t(props.locale, "nl2ui.prefs.cardStyle.modern")}</option>
                <option value="classic">{t(props.locale, "nl2ui.prefs.cardStyle.classic")}</option>
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "nl2ui.prefs.colorTheme")}</span>
              <select value={nl2uiColorTheme} onChange={(e) => setNl2uiColorTheme(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6 }}>
                <option value="blue">{t(props.locale, "nl2ui.prefs.colorTheme.blue")}</option>
                <option value="green">{t(props.locale, "nl2ui.prefs.colorTheme.green")}</option>
                <option value="warm">{t(props.locale, "nl2ui.prefs.colorTheme.warm")}</option>
                <option value="dark">{t(props.locale, "nl2ui.prefs.colorTheme.dark")}</option>
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "nl2ui.prefs.density")}</span>
              <select value={nl2uiDensity} onChange={(e) => setNl2uiDensity(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6 }}>
                <option value="compact">{t(props.locale, "nl2ui.prefs.density.compact")}</option>
                <option value="comfortable">{t(props.locale, "nl2ui.prefs.density.comfortable")}</option>
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "nl2ui.prefs.defaultLayout")}</span>
              <select value={nl2uiDefaultLayout} onChange={(e) => setNl2uiDefaultLayout(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6 }}>
                <option value="list">{t(props.locale, "nl2ui.prefs.defaultLayout.list")}</option>
                <option value="cards">{t(props.locale, "nl2ui.prefs.defaultLayout.cards")}</option>
                <option value="kanban">{t(props.locale, "nl2ui.prefs.defaultLayout.kanban")}</option>
                <option value="table">{t(props.locale, "nl2ui.prefs.defaultLayout.table")}</option>
              </select>
            </label>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={saveNl2uiPrefs} disabled={nl2uiPrefsStatus === "saving"}>
              {nl2uiPrefsStatus === "saving" ? t(props.locale, "action.saving") : t(props.locale, "action.save")}
            </button>
            <button onClick={clearNl2uiPrefs}>
              {t(props.locale, "action.clear")}
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
