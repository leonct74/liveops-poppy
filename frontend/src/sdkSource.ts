// The Unity SDK is GENERATED, not shipped as a package: one dependency-free C# file with
// the studio's endpoint and title id already filled in. That is a deliberate product
// decision (DESIGN.md §4) — a package registry, a version matrix and an engine-support
// treadmill is the cost that sinks small backend products, and the whole client surface
// here is two HTTP calls.
//
// Pure functions so the generated source is unit-testable without a browser or Unity.

export interface SdkOptions {
  endpoint: string;
  titleId: string;
  /** Never the real key: keys are shown once at creation and we only hold a hash. */
  keyPlaceholder?: string;
}

const DEFAULT_KEY_PLACEHOLDER = "PASTE_YOUR_TITLE_KEY_HERE";

/** Strip a trailing slash so `${endpoint}/e` can never become `//e`. */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

export function unitySdkSource(options: SdkOptions): string {
  const endpoint = normalizeEndpoint(options.endpoint);
  const key = options.keyPlaceholder ?? DEFAULT_KEY_PLACEHOLDER;
  return `// LiveOpsPoppy — generated for title ${options.titleId}
//
// Drop this file anywhere in Assets/. No packages, no dependencies.
//
//   LiveOps.Init();                                  // once, at startup
//   float dmg = LiveOps.GetFloat("balance.shotgunDamage", 30f);
//   LiveOps.Track("level_complete", 3);
//
// Your game NEVER breaks if this backend is unreachable: config falls back to the last
// value it saw, then to the default you pass in. Events queue on disk and retry.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

public static class LiveOps
{
    const string Endpoint = "${endpoint}";
    const string TitleId  = "${options.titleId}";
    const string TitleKey = "${key}";

    const string Env = "prod";              // switch to "dev" in your development builds
    const float  ConfigRefreshSeconds = 300f;
    const float  FlushIntervalSeconds = 30f;
    const int    MaxBatch = 25;

    static Dictionary<string, object> _config = new Dictionary<string, object>();
    static readonly List<Dictionary<string, object>> _queue = new List<Dictionary<string, object>>();
    static string _etag, _installId, _sessionId;
    static float _sessionStart;
    static bool _started;
    static LiveOpsRunner _runner;

    static string ConfigCache => Path.Combine(Application.persistentDataPath, "liveops-config.json");
    static string QueueCache  => Path.Combine(Application.persistentDataPath, "liveops-queue.json");

    /// <summary>Call once at startup. Safe to call again — it does nothing the second time.</summary>
    public static void Init()
    {
        if (_started) return;
        _started = true;

        _installId = PlayerPrefs.GetString("liveops.iid", "");
        if (string.IsNullOrEmpty(_installId))
        {
            // A random id, generated on this device. Not an advertising id, not a device
            // fingerprint — it identifies an install, and nothing else.
            _installId = Guid.NewGuid().ToString();
            PlayerPrefs.SetString("liveops.iid", _installId);
            PlayerPrefs.Save();
        }
        _sessionId = Guid.NewGuid().ToString("N").Substring(0, 16);
        _sessionStart = Time.realtimeSinceStartup;

        LoadCachedConfig();
        LoadQueue();

        var go = new GameObject("LiveOpsPoppy");
        UnityEngine.Object.DontDestroyOnLoad(go);
        _runner = go.AddComponent<LiveOpsRunner>();
        _runner.StartCoroutine(ConfigLoop());
        _runner.StartCoroutine(FlushLoop());

        Track("session_start");
    }

    // ── Config ────────────────────────────────────────────────────────────────────
    public static string GetString(string path, string fallback = "")
    {
        var v = Lookup(path);
        return v == null ? fallback : Convert.ToString(v, CultureInfo.InvariantCulture);
    }

    public static float GetFloat(string path, float fallback = 0f)
    {
        var v = Lookup(path);
        if (v == null) return fallback;
        try { return Convert.ToSingle(v, CultureInfo.InvariantCulture); } catch { return fallback; }
    }

    public static int GetInt(string path, int fallback = 0)
    {
        var v = Lookup(path);
        if (v == null) return fallback;
        try { return Convert.ToInt32(Convert.ToSingle(v, CultureInfo.InvariantCulture)); } catch { return fallback; }
    }

    public static bool GetBool(string path, bool fallback = false)
    {
        var v = Lookup(path);
        if (v is bool b) return b;
        return fallback;
    }

    /// <summary>Dotted path lookup: "shop.starterBundlePrice".</summary>
    static object Lookup(string path)
    {
        var node = (object)_config;
        foreach (var part in path.Split('.'))
        {
            var dict = node as Dictionary<string, object>;
            if (dict == null || !dict.TryGetValue(part, out node)) return null;
        }
        return node;
    }

    // ── Events ────────────────────────────────────────────────────────────────────
    public static void Track(string name) { Enqueue(name, null); }
    public static void Track(string name, double value) { Enqueue(name, value); }

    static void Enqueue(string name, double? value)
    {
        if (string.IsNullOrEmpty(name)) return;
        var ev = new Dictionary<string, object> { { "n", name } };
        if (value.HasValue) ev["v"] = value.Value;
        lock (_queue)
        {
            // Bound the on-disk queue: a player offline for a week must not grow it forever.
            if (_queue.Count >= 500) _queue.RemoveAt(0);
            _queue.Add(ev);
        }
    }

    internal static void EndSession()
    {
        Track("session_end", Math.Round(Time.realtimeSinceStartup - _sessionStart));
        SaveQueue();
    }

    // ── Loops ─────────────────────────────────────────────────────────────────────
    static IEnumerator ConfigLoop()
    {
        while (true)
        {
            yield return FetchConfig();
            yield return new WaitForSeconds(ConfigRefreshSeconds);
        }
    }

    static IEnumerator FetchConfig()
    {
        var url = Endpoint + "/config/" + TitleId + "/" + Env + "?k=" + UnityWebRequest.EscapeURL(TitleKey);
        using (var req = UnityWebRequest.Get(url))
        {
            if (!string.IsNullOrEmpty(_etag)) req.SetRequestHeader("If-None-Match", _etag);
            yield return req.SendWebRequest();
#if UNITY_2020_1_OR_NEWER
            var failed = req.result != UnityWebRequest.Result.Success;
#else
            var failed = req.isNetworkError || req.isHttpError;
#endif
            // 304 = unchanged; keep what we have. Anything else that failed: also keep what
            // we have. The game must never stall or misbehave because config didn't load.
            if (failed || req.responseCode == 304) yield break;

            var tag = req.GetResponseHeader("ETag");
            if (!string.IsNullOrEmpty(tag)) _etag = tag;
            var body = req.downloadHandler.text;
            var parsed = LiveOpsJson.Parse(body) as Dictionary<string, object>;
            if (parsed != null && parsed.TryGetValue("config", out var cfg) && cfg is Dictionary<string, object> map)
            {
                _config = map;
                try { File.WriteAllText(ConfigCache, body); } catch { }
            }
        }
    }

    static IEnumerator FlushLoop()
    {
        while (true)
        {
            yield return new WaitForSeconds(FlushIntervalSeconds);
            yield return Flush();
        }
    }

    internal static IEnumerator Flush()
    {
        // Take the batch inside the lock, then leave it before yielding. A coroutine
        // suspends at every 'yield', and a Monitor held across a suspension point is a
        // deadlock waiting to happen (and 'yield' inside 'lock' is a construct to avoid
        // in an iterator regardless) — so nothing below this block touches the lock.
        List<Dictionary<string, object>> batch = null;
        lock (_queue)
        {
            if (_queue.Count > 0)
            {
                var take = Math.Min(MaxBatch, _queue.Count);
                batch = _queue.GetRange(0, take);
                _queue.RemoveRange(0, take);
            }
        }
        if (batch == null) yield break;

        var sb = new StringBuilder();
        sb.Append("{\\"t\\":").Append(LiveOpsJson.Quote(TitleId));
        sb.Append(",\\"k\\":").Append(LiveOpsJson.Quote(TitleKey));
        sb.Append(",\\"s\\":{\\"iid\\":").Append(LiveOpsJson.Quote(_installId));
        sb.Append(",\\"sid\\":").Append(LiveOpsJson.Quote(_sessionId));
        sb.Append(",\\"plat\\":").Append(LiveOpsJson.Quote(Application.platform.ToString()));
        sb.Append(",\\"ver\\":").Append(LiveOpsJson.Quote(Application.version)).Append("}");
        sb.Append(",\\"e\\":[");
        for (var i = 0; i < batch.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\\"n\\":").Append(LiveOpsJson.Quote((string)batch[i]["n"]));
            if (batch[i].ContainsKey("v"))
                sb.Append(",\\"v\\":").Append(Convert.ToDouble(batch[i]["v"]).ToString("R", CultureInfo.InvariantCulture));
            sb.Append('}');
        }
        sb.Append("]}");

        using (var req = new UnityWebRequest(Endpoint + "/e", "POST"))
        {
            req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(sb.ToString()));
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");
            yield return req.SendWebRequest();
#if UNITY_2020_1_OR_NEWER
            var failed = req.result != UnityWebRequest.Result.Success;
#else
            var failed = req.isNetworkError || req.isHttpError;
#endif
            if (failed)
            {
                // 429 = this title hit its daily cap. Drop the batch rather than retrying
                // into a wall: retrying can only add cost and cannot deliver.
                if (req.responseCode == 429) yield break;
                // 4xx means the request itself is wrong (bad key, malformed) — retrying
                // forever would never help either.
                if (req.responseCode >= 400 && req.responseCode < 500) yield break;
                lock (_queue) { _queue.InsertRange(0, batch); }  // transient: try again later
            }
        }
    }

    // ── Persistence ───────────────────────────────────────────────────────────────
    static void LoadCachedConfig()
    {
        try
        {
            if (!File.Exists(ConfigCache)) return;
            var parsed = LiveOpsJson.Parse(File.ReadAllText(ConfigCache)) as Dictionary<string, object>;
            if (parsed != null && parsed.TryGetValue("config", out var cfg) && cfg is Dictionary<string, object> map)
                _config = map;
        }
        catch { }
    }

    static void LoadQueue()
    {
        try
        {
            if (!File.Exists(QueueCache)) return;
            if (LiveOpsJson.Parse(File.ReadAllText(QueueCache)) is List<object> list)
                foreach (var item in list)
                    if (item is Dictionary<string, object> ev && ev.ContainsKey("n")) _queue.Add(ev);
            File.Delete(QueueCache);
        }
        catch { }
    }

    internal static void SaveQueue()
    {
        try
        {
            var sb = new StringBuilder("[");
            lock (_queue)
            {
                for (var i = 0; i < _queue.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append("{\\"n\\":").Append(LiveOpsJson.Quote((string)_queue[i]["n"]));
                    if (_queue[i].ContainsKey("v"))
                        sb.Append(",\\"v\\":").Append(Convert.ToDouble(_queue[i]["v"]).ToString("R", CultureInfo.InvariantCulture));
                    sb.Append('}');
                }
            }
            sb.Append(']');
            File.WriteAllText(QueueCache, sb.ToString());
        }
        catch { }
    }
}

/// <summary>Drives the coroutines and catches pause/quit so a session is never lost.</summary>
public class LiveOpsRunner : MonoBehaviour
{
    void OnApplicationPause(bool paused)
    {
        if (!paused) return;
        LiveOps.SaveQueue();          // the OS may kill us while backgrounded
        StartCoroutine(LiveOps.Flush());
    }

    void OnApplicationQuit()
    {
        LiveOps.EndSession();
    }
}

/// <summary>A minimal JSON reader — enough for config documents, and no dependencies.</summary>
public static class LiveOpsJson
{
    public static object Parse(string text)
    {
        var i = 0;
        try { return ParseValue(text, ref i); } catch { return null; }
    }

    public static string Quote(string s)
    {
        var sb = new StringBuilder("\\"");
        foreach (var c in s ?? "")
        {
            if (c == '"' || c == '\\\\') sb.Append('\\\\').Append(c);
            else if (c == '\\n') sb.Append("\\\\n");
            else if (c == '\\r') sb.Append("\\\\r");
            else if (c == '\\t') sb.Append("\\\\t");
            else if (c < ' ') sb.Append("\\\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static object ParseValue(string s, ref int i)
    {
        SkipWhite(s, ref i);
        switch (s[i])
        {
            case '{': return ParseObject(s, ref i);
            case '[': return ParseArray(s, ref i);
            case '"': return ParseString(s, ref i);
            case 't': i += 4; return true;
            case 'f': i += 5; return false;
            case 'n': i += 4; return null;
            default:  return ParseNumber(s, ref i);
        }
    }

    static Dictionary<string, object> ParseObject(string s, ref int i)
    {
        var map = new Dictionary<string, object>();
        i++; // {
        SkipWhite(s, ref i);
        if (s[i] == '}') { i++; return map; }
        while (true)
        {
            SkipWhite(s, ref i);
            var key = ParseString(s, ref i);
            SkipWhite(s, ref i);
            i++; // :
            map[key] = ParseValue(s, ref i);
            SkipWhite(s, ref i);
            if (s[i] == ',') { i++; continue; }
            i++; // }
            return map;
        }
    }

    static List<object> ParseArray(string s, ref int i)
    {
        var list = new List<object>();
        i++; // [
        SkipWhite(s, ref i);
        if (s[i] == ']') { i++; return list; }
        while (true)
        {
            list.Add(ParseValue(s, ref i));
            SkipWhite(s, ref i);
            if (s[i] == ',') { i++; continue; }
            i++; // ]
            return list;
        }
    }

    static string ParseString(string s, ref int i)
    {
        var sb = new StringBuilder();
        i++; // opening quote
        while (s[i] != '"')
        {
            if (s[i] == '\\\\')
            {
                i++;
                switch (s[i])
                {
                    case 'n': sb.Append('\\n'); break;
                    case 'r': sb.Append('\\r'); break;
                    case 't': sb.Append('\\t'); break;
                    case 'u':
                        sb.Append((char)Convert.ToInt32(s.Substring(i + 1, 4), 16));
                        i += 4;
                        break;
                    default: sb.Append(s[i]); break;
                }
            }
            else sb.Append(s[i]);
            i++;
        }
        i++; // closing quote
        return sb.ToString();
    }

    static double ParseNumber(string s, ref int i)
    {
        var start = i;
        while (i < s.Length && "-+.eE0123456789".IndexOf(s[i]) >= 0) i++;
        return double.Parse(s.Substring(start, i - start), CultureInfo.InvariantCulture);
    }

    static void SkipWhite(string s, ref int i)
    {
        while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
    }
}
`;
}

/** curl for the two endpoints — an Unreal/Godot/custom-engine dev integrates from these
 *  alone, which is why plain REST is a first-class citizen and not a footnote. */
export function restSnippets(options: SdkOptions): { config: string; events: string } {
  const endpoint = normalizeEndpoint(options.endpoint);
  const key = options.keyPlaceholder ?? DEFAULT_KEY_PLACEHOLDER;
  return {
    config: `curl "${endpoint}/config/${options.titleId}/prod?k=${key}"
# → {"v":7,"config":{...}}   send If-None-Match: "v7" to get a cheap 304`,
    events: `curl -X POST "${endpoint}/e" -H "content-type: application/json" -d '{
  "t": "${options.titleId}",
  "k": "${key}",
  "s": { "iid": "<random-install-uuid>", "sid": "<session-id>", "plat": "windows", "ver": "1.0.0" },
  "e": [ { "n": "session_start" }, { "n": "level_complete", "v": 3 } ]
}'
# → 202 {"ok":true,"accepted":2}   429 means this title hit its daily event cap`,
  };
}
