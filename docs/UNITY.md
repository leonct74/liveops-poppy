# The Unity rig — how to prove the SDK actually works

## Status: the generated C# has never been compiled

Be blunt about this, because it is the one gap in the repo's test coverage.

Everything else here is verified by `npm test`. The generated `LiveOps.cs` is **checked
lexically** — `frontend/src/sdkSource.test.ts` walks it the way a compiler's first pass
would (comments, string and char literals, escapes, bracket balance) and fails on the
escaping bugs that a JavaScript template literal emitting C# invites. That catches the class
of mistake that would otherwise reach a studio's console.

It is not a compile. No machine in this repo has a C# toolchain or a Unity install, so
nothing has yet proven that this file builds, that a coroutine ordering is right, or that
`Application.persistentDataPath` behaves as assumed on a device.

**Do this rig on a machine with Unity before listing the poppy.** Until it is done and
recorded below, the SDK is unproven, and the honest thing to say publicly is "REST is the
supported surface; the Unity file is a beta convenience."

---

## Setup (about 15 minutes)

1. **Deploy a backend.** In AgentsPoppy: LiveOpsPoppy → Setup → Deploy. Create a title
   (`Titles` tab) and copy the key — it is shown once.
2. **Generate the SDK.** `Get it into your game` → Unity → *Download LiveOps.cs*.
3. **New Unity project**, any 2020.3+ version, any render pipeline. Drop `LiveOps.cs` into
   `Assets/`. Replace `PASTE_YOUR_TITLE_KEY_HERE` with your key.
4. Change `const string Env = "prod";` to `"dev"` for the rig, so you are not publishing to
   your real environment while testing.
5. Add one script to the scene:

```csharp
using UnityEngine;

public class Rig : MonoBehaviour
{
    void Start()
    {
        LiveOps.Init();
        Debug.Log("shotgunDamage = " + LiveOps.GetFloat("balance.shotgunDamage", 30f));
    }

    void Update()
    {
        if (Input.GetKeyDown(KeyCode.Space)) LiveOps.Track("level_complete", 1);
    }
}
```

Set **Player Settings → Version** to something recognisable (`1.0.0-rig`) — it shows up in
the dashboard's version split and is how you confirm the events are yours.

---

## The four checks

### 1. Offline boot — the game never depends on us

The most important property in the whole product: a studio's game must not be worse off for
having integrated this.

1. Turn off networking (airplane mode, or point `Endpoint` at
   `https://127.0.0.1:1` for a hard failure).
2. Play from a clean state — delete `Application.persistentDataPath` first so no cached
   config exists.

**Pass:** the scene runs, the log prints `shotgunDamage = 30` (your in-code default), and no
exception appears in the console. Nothing hangs at startup.

3. Restore networking, play, stop, then break networking again and play once more.

**Pass:** the second offline run prints the value **from the server**, not the default — the
cached document in `liveops-config.json` was loaded.

### 2. A config change reaches a running game

1. In the poppy's Config editor, set `balance.shotgunDamage` to `99` and publish.
2. With the game already running, wait.

**Pass:** within `ConfigRefreshSeconds` (5 minutes), a fresh `GetFloat` call returns `99`.
The quickest way to see it is to log the value on every space-bar press.

3. Publish again with no change and watch the network traffic.

**Pass:** the second poll returns **304**, not a full document — `If-None-Match` is working.

4. Roll back in the editor.

**Pass:** the running game returns to the previous value within one refresh.

### 3. Events land on the dashboard

1. Play, press space a dozen times, then **quit properly** (Stop in the editor is enough —
   `OnApplicationQuit` fires).
2. Open the poppy's Dashboard, select today.

**Pass:** DAU shows 1, sessions shows 1, average session length is roughly how long you
played, `level_complete` appears with your count, and the platform/version split shows your
editor platform and `1.0.0-rig`.

3. Play again the same day from the same machine.

**Pass:** DAU is still **1** — the install id is stable and unique-per-day counting works.
Sessions is now 2.

4. Kill the app hard (Task Manager / force-quit) mid-session with queued events, then relaunch.

**Pass:** the queued events arrive after the relaunch. This is `liveops-queue.json` doing its
job, and it is the check most likely to fail on mobile, where the OS kills backgrounded apps
without warning.

### 4. The cap is real, and the client respects it

You do not need Unity for the server half — `scripts/simulate-game.mjs --flood` drives a
title past its cap far faster than a game can. Do that first, on a **throwaway title**, and
confirm the `429`.

Then the client half, which is what only Unity can show:

1. Set the throwaway title's daily cap to something tiny (e.g. 100) in the poppy.
2. Run the flood script until the cap trips.
3. Play the Unity rig against that same title and press space repeatedly.

**Pass:** the SDK stops sending. There is no retry storm in the network profiler, no
exception, and the game plays normally. A capped backend is invisible to the player.

---

## Record the result

When the rig passes, add a line to `IMPLEMENTATION.md` §8 P5 with the date, the Unity
version, and the platform tested — the same way every live AWS verification in this project
is recorded. If something fails, fix it in `frontend/src/sdkSource.ts` (the generator, never
a downloaded copy) and add a test that would have caught it.

## Platforms worth a second pass

The rig above in the Editor proves the logic. Two things genuinely differ on device and
deserve a repeat of check 3 at minimum:

- **iOS/Android** — `Application.persistentDataPath` differs, and the OS kills backgrounded
  apps. `OnApplicationPause` is the only hook that fires reliably; `OnApplicationQuit` often
  does not.
- **WebGL** — no threads and no filesystem. `File.WriteAllText` to `persistentDataPath` maps
  to IndexedDB and is flushed asynchronously, and the `lock` statements are no-ops. Expect to
  need a WebGL branch; do not claim WebGL support until this check passes there.
