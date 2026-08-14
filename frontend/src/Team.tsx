// The Team tab — the PREMIUM surface (DESIGN §10).
//
// What it sells, in one line: your producer, designer or investor reads the game's numbers
// in a browser, with no AgentsPoppy install and no AWS access.
//
// Three rules this screen exists to honour:
//  1. The gate is the HOST's, not ours. `isPurchased` is verified server-side and we never
//     cache it. We render our OWN buy control because this repo inlines the host bridge
//     (host.ts) rather than depending on the unpublished SDK — so there is no
//     <agentspoppy-purchase> custom element to mount, and using one would render an empty
//     box: a silently dead paywall. Rendering it ourselves means the platform rule falls on
//     us — see rule 4.
//  2. The monthly framing ("$1 a month per game") is COPY BESIDE the button, computed from
//     the live product price — never printed on a control that charges yearly.
//  3. Turning the dashboard off is a REMOVAL, not a pause: it destroys the team's sign-ins
//     and changes the address. It must read that way and confirm.
//  4. ⚠️ PLATFORM RULE — DO NOT REMOVE THE "Manage billing" CONTROL. A buyer must ALWAYS
//     have a visible way to cancel and see what they paid, present the moment the feature
//     is owned, not buried. Omitting it is grounds for removal from the directory.

import { useCallback, useEffect, useState } from "react";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import { host, type PurchaseInfo } from "./host";
import type { Api, TeamStatus } from "./api";

/** The platform product this poppy sells, per TITLE (DESIGN §10). */
export const TEAM_PRODUCT_ID = "team-dashboard";

export interface PriceDisplay {
  /** The big number on the button. */
  headline: string;
  /** What they'll actually be charged, and when. Never omitted for a yearly plan. */
  note?: string;
}

/**
 * Present a yearly subscription as a MONTHLY headline with the real yearly charge beside
 * it — the founder's framing ("show the price x months, but we bill yearly"), and the same
 * shape TrafficPoppy uses so the two poppies read alike.
 *
 * Derived from the LIVE price so it follows the platform product; a hardcoded string would
 * quietly lie the day the price changes. The yearly total is ALWAYS shown next to the
 * monthly figure — a monthly headline on a yearly charge is a dark pattern without it.
 */
export function displayPrice(price: PurchaseInfo["price"]): PriceDisplay | null {
  if (!price) return null;
  const { amountMinor, currency, kind, interval } = price;
  const money = (m: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(m / 100);
  if (kind !== "subscription") return { headline: money(amountMinor) };
  if (interval === "year") {
    return {
      headline: `${money(Math.round(amountMinor / 12))}/month`,
      note: `billed yearly · ${money(amountMinor)} per game`,
    };
  }
  return { headline: `${money(amountMinor)}/${interval ?? "month"}` };
}

export function Team({
  api,
  titleId,
  titleName,
  isLive,
  bridge = host,
  pollMs = 3000,
}: {
  api: Api;
  titleId: string;
  titleName?: string;
  isLive: boolean;
  /** Injected so tests drive entitlement without the host. */
  bridge?: Pick<typeof host, "isPurchased" | "purchaseInfo" | "buyProduct" | "manageSubscription">;
  /** How often to re-read while CloudFormation works. Injected so tests run in ms. */
  pollMs?: number;
}) {
  const [owned, setOwned] = useState<boolean | null>(null);
  const [info, setInfo] = useState<PurchaseInfo | null>(null);
  const [status, setStatus] = useState<TeamStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Entitlement is per TITLE, so it is re-checked whenever the selected game changes.
  // Nothing is asked before there's a backend: with no deployment there is nothing to
  // unlock, and a purchase question the user can't act on is just a wasted host round-trip.
  const refreshEntitlement = useCallback(async () => {
    if (!titleId || !isLive) return;
    try {
      const [isOwned, purchase] = await Promise.all([
        bridge.isPurchased(TEAM_PRODUCT_ID, { target: titleId }),
        bridge.purchaseInfo(TEAM_PRODUCT_ID, { target: titleId }).catch(() => null),
      ]);
      setOwned(isOwned);
      setInfo(purchase);
    } catch {
      // Fail CLOSED: if we can't confirm ownership, we don't unlock.
      setOwned(false);
    }
  }, [bridge, titleId, isLive]);

  const refreshStatus = useCallback(async () => {
    if (!isLive) return;
    try {
      setStatus(await api.teamStatus());
      // A good read clears a stale failure. Without this the CloudFormation error from a
      // double-clicked Set-up button sat on screen indefinitely, over a stack that had
      // long since finished the very thing the message said it couldn't start.
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, isLive]);

  /**
   * 🪤 Enabling the viewer plane is a CloudFormation UPDATE that takes ~2 minutes, but
   * `enableTeam()` returns as soon as AWS ACCEPTS it — long before ViewerUrl exists. This
   * panel has no poll of its own, so a single read taken the instant that call returned
   * always landed mid-update, saw no viewer plane, and never looked again: the founder was
   * shown "no team to set up" by a stack that was at that moment building exactly that,
   * and only a tab remount revealed it (2026-08-14). So wait for the plane to actually
   * appear before handing the panel back.
   *
   * Reads are ALLOWED TO FAIL here — describing a stack mid-update can throw, and that is
   * not a reason to give up on a change AWS already accepted; only the deadline is.
   */
  const waitForTeam = useCallback(
    async (want: boolean) => {
      const deadline = Date.now() + 4 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        try {
          const next = await api.teamStatus();
          setStatus(next);
          if (next.enabled === want) {
            setError(null);
            return;
          }
        } catch {
          /* transient mid-update read — keep waiting */
        }
      }
      setError("This is taking longer than expected. Check the Setup tab for your stack's status.");
    },
    [api, pollMs],
  );

  useEffect(() => {
    void refreshEntitlement();
  }, [refreshEntitlement]);
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refreshStatus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!isLive) {
    return (
      <div className="card">
        <div className="section-title">Team dashboard</div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Set up your backend first — the team dashboard runs in your own AWS account, next to
          your game's data.
        </p>
      </div>
    );
  }

  const price = displayPrice(info?.price ?? null);

  return (
    <>
      <div className="card">
        <div className="section-title">Team dashboard</div>
        <p className="muted" style={{ marginTop: 0 }}>
          Right now these numbers live in this app, on this computer, behind your AWS access.
          The team dashboard puts them in a browser: your producer, designer or investor signs
          in and reads {titleName ? <strong>{titleName}</strong> : "your game"}&apos;s numbers —
          no AgentsPoppy, no AWS account, read-only. It runs in <strong>your</strong> AWS, like
          everything else here.
        </p>

        {owned === null && (
          <div className="row" style={{ marginTop: 12 }}>
            <span className="spinner" /> <span className="muted">Checking your subscription…</span>
          </div>
        )}

        {owned === false && (
          <div className="card card-2 stack" style={{ marginTop: 12, marginBottom: 0 }}>
            <div className="spread" style={{ alignItems: "center", gap: 10 }}>
              <span className="muted" style={{ fontSize: 13 }}>
                {price ? (
                  <>
                    <strong>{price.headline}</strong> for{" "}
                    <span className="mono">{titleName ?? titleId}</span>
                    {price.note ? <> · {price.note}</> : null} · cancel any time
                  </>
                ) : (
                  <>Priced per game · cancel any time</>
                )}
              </span>
              <Button
                className="btn btn-primary"
                busyLabel="Opening checkout…"
                onClick={async () => {
                  await bridge.buyProduct(TEAM_PRODUCT_ID, { target: titleId });
                  // Never trust the resolve value as authority — re-ask the host, which
                  // verifies ownership server-side.
                  await refreshEntitlement();
                }}
              >
                {price ? `Unlock · ${price.headline}` : "Unlock"}
              </Button>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Unlimited team members; each game is bought separately.
            </p>
          </div>
        )}

        {/* Owned: the Manage control is REQUIRED here and must stay visible (rule 4). */}
        {owned === true && (
          <div className="spread" style={{ marginTop: 12, alignItems: "center" }}>
            <span className="badge ok">
              <span className="dot" /> Subscribed · {titleName ?? titleId}
            </span>
            <button
              className="btn btn-sm"
              onClick={() => void bridge.manageSubscription(TEAM_PRODUCT_ID, { target: titleId })}
            >
              Manage billing
            </button>
          </div>
        )}

        {owned === true && !status?.enabled && (
          <div style={{ marginTop: 12 }}>
            <Button
              className="btn btn-primary"
              busyLabel="Setting it up…"
              onClick={() =>
                run("enable", async () => {
                  await api.enableTeam();
                  await waitForTeam(true);
                })
              }
            >
              Set up the team dashboard
            </Button>
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
              This adds a sign-in service and a small web app to your stack. About two minutes.
            </p>
          </div>
        )}

        {error && (
          <div className="banner err" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
      </div>

      {owned === true && status?.enabled && status.dashboardUrl && (
        <>
          <div className="card">
            <div className="section-title">Your team&apos;s address</div>
            <div className="row" style={{ gap: 8 }}>
              <code style={{ flex: 1, wordBreak: "break-all", fontSize: 13 }}>{status.dashboardUrl}</code>
              <CopyButton text={status.dashboardUrl} label="Copy link" />
            </div>
            <p className="muted" style={{ marginBottom: 0, fontSize: 13 }}>
              Send this to your team — it doesn&apos;t change. Anyone you invite below signs in
              here; nobody else can read anything.
            </p>
          </div>

          <div className="card">
            <div className="section-title">Who can see the numbers</div>
            <div className="stack" style={{ marginBottom: 10 }}>
              {(status.viewers ?? []).length === 0 && (
                <p className="muted" style={{ margin: 0 }}>
                  Nobody yet. Invite the first person below.
                </p>
              )}
              {(status.viewers ?? []).map((v) => (
                <div key={v.email} className="card card-2 spread" style={{ alignItems: "center" }}>
                  <div>
                    <div>{v.email}</div>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {v.status === "invited"
                        ? "Invited — hasn't signed in yet"
                        : v.status === "active"
                          ? "Active"
                          : v.status}
                    </span>
                  </div>
                  <Button
                    className="btn btn-sm"
                    busyLabel="Removing…"
                    onClick={() => run(`remove:${v.email}`, () => api.removeViewer(v.email))}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>

            <div className="row" style={{ gap: 8 }}>
              <input
                className="input"
                style={{ flex: 1, minWidth: 200 }}
                type="email"
                autoCapitalize="off"
                placeholder="producer@yourstudio.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button
                className="btn btn-primary"
                busyLabel="Inviting…"
                disabled={!email.trim() || busy === "invite"}
                onClick={() =>
                  run("invite", async () => {
                    await api.inviteViewer(email.trim());
                    setEmail("");
                  })
                }
              >
                Invite
              </Button>
            </div>
            <p className="muted" style={{ marginBottom: 8, fontSize: 13 }}>
              They get an email with a temporary password and choose their own on first sign-in —
              you never see it. Removing someone takes effect within the hour.
            </p>
            {/* Cognito's built-in sender is an unfamiliar amazonaws address with no domain
                reputation, so this mail lands in spam routinely. Saying so up front turns a
                support question ("nobody got the invite") into a five-second check — the
                founder's own invite went to spam on the first live test (2026-08-14). */}
            <p className="banner warn" style={{ marginBottom: 0, fontSize: 13 }}>
              <strong>Tell them to check their spam folder.</strong> The invite comes from
              Amazon&apos;s sign-in service (<code>no-reply@verificationemail.com</code>), not from
              your studio, so mail filters often catch it. It is not lost — it is nearly always
              in spam.
            </p>
          </div>

          <div className="card">
            <div className="section-title">Remove the team dashboard</div>
            {/* Never a toggle: the resources are condition-gated, so turning this off deletes
                the Cognito pool with them — every sign-in is destroyed and a later re-enable
                mints a different address (DESIGN §10). Say so before asking. */}
            <p className="muted" style={{ marginTop: 0 }}>
              This deletes the sign-in service and the web app from your AWS.{" "}
              <strong>Everyone you invited loses access</strong>, and if you set it up again later
              the address will be different. Your game&apos;s data is untouched.
            </p>
            {confirmRemove ? (
              <div className="row" style={{ gap: 8 }}>
                <Button
                  className="btn btn-danger"
                  busyLabel="Removing…"
                  onClick={() =>
                    run("disable", async () => {
                      await api.disableTeam();
                      setConfirmRemove(false);
                    })
                  }
                >
                  Yes, remove it and delete the sign-ins
                </Button>
                <button className="btn btn-sm" onClick={() => setConfirmRemove(false)}>
                  Keep it
                </button>
              </div>
            ) : (
              <button className="btn btn-sm" onClick={() => setConfirmRemove(true)}>
                Remove the team dashboard
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
