#!/usr/bin/env python3
"""weather-lens — a minimal Synaps tool extension.

The simplest possible catalogue tool: one `get_weather` tool, live data from
the free open-meteo API (no API key), Python stdlib only (no deps, no venv).

Protocol: Content-Length-framed JSON-RPC over stdin/stdout (mirrors finlens).
  initialize → advertise tools
  tool.call  → dispatch
  shutdown   → exit
"""
import sys
import json
import urllib.request
import urllib.parse

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

# WMO weather interpretation codes → human description
WMO = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "depositing rime fog",
    51: "light drizzle", 53: "moderate drizzle", 55: "dense drizzle",
    61: "slight rain", 63: "moderate rain", 65: "heavy rain",
    66: "light freezing rain", 67: "heavy freezing rain",
    71: "slight snow", 73: "moderate snow", 75: "heavy snow", 77: "snow grains",
    80: "slight rain showers", 81: "moderate rain showers", 82: "violent rain showers",
    85: "slight snow showers", 86: "heavy snow showers",
    95: "thunderstorm", 96: "thunderstorm w/ slight hail", 99: "thunderstorm w/ heavy hail",
}

TOOLS = [
    {
        "name": "get_weather",
        "description": ("Get the current weather for a city or place by name. "
                        "Returns temperature, conditions, wind, and humidity from live "
                        "open-meteo data. Use this instead of guessing — never fabricate weather."),
        "input_schema": {
            "type": "object",
            "properties": {
                "location": {"type": "string",
                             "description": "City or place name, e.g. 'Tokyo' or 'Newark, NJ'."}
            },
            "required": ["location"],
        },
    },
]


# ── HTTP helper (stdlib only) ────────────────────────────────────────────────
def _get_json(url: str, params: dict) -> dict:
    full = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(full, headers={"User-Agent": "weather-lens/0.1"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_weather(location: str) -> str:
    location = (location or "").strip()
    if not location:
        return "No location given. Provide a city or place name."

    geo = _get_json(GEOCODE_URL, {"name": location, "count": 1})
    results = geo.get("results") or []
    if not results and "," in location:
        # "Newark, NJ" → geocoder wants the bare name; retry with the first part
        geo = _get_json(GEOCODE_URL, {"name": location.split(",", 1)[0].strip(), "count": 1})
        results = geo.get("results") or []
    if not results:
        return f"Could not find a place named '{location}'."
    place = results[0]
    lat, lon = place["latitude"], place["longitude"]
    label = ", ".join(filter(None, [place.get("name"), place.get("admin1"), place.get("country")]))

    fc = _get_json(FORECAST_URL, {
        "latitude": lat, "longitude": lon,
        "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
    })
    cur = fc.get("current") or {}
    units = fc.get("current_units") or {}
    code = cur.get("weather_code")
    desc = WMO.get(code, f"code {code}")
    temp = cur.get("temperature_2m")
    hum = cur.get("relative_humidity_2m")
    wind = cur.get("wind_speed_10m")
    t_u = units.get("temperature_2m", "°C")
    w_u = units.get("wind_speed_10m", "km/h")

    return (f"Weather in {label}: {desc}, {temp}{t_u}. "
            f"Humidity {hum}%, wind {wind} {w_u}.")


def dispatch_tool(name: str, inp: dict) -> str:
    if name == "get_weather":
        return get_weather(inp.get("location", ""))
    raise ValueError(f"unknown tool: {name}")


# ── JSON-RPC framing ─────────────────────────────────────────────────────────
def _read_message():
    line = b""
    while not line.endswith(b"\r\n"):
        ch = sys.stdin.buffer.read(1)
        if not ch:
            return None
        line += ch
    header = line.decode("ascii").strip()
    if not header.lower().startswith("content-length:"):
        return None
    length = int(header.split(":", 1)[1].strip())
    sys.stdin.buffer.read(2)  # trailing CRLF of header block
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode("utf-8"))


def _send_message(obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
    sys.stdout.buffer.write(header + body)
    sys.stdout.buffer.flush()


def _ok(req_id, result):
    _send_message({"jsonrpc": "2.0", "id": req_id, "result": result})


def _err(req_id, code, message):
    _send_message({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def main():
    while True:
        msg = _read_message()
        if msg is None:
            break
        method = msg.get("method", "")
        req_id = msg.get("id")
        params = msg.get("params", {}) or {}
        try:
            if method == "initialize":
                _ok(req_id, {"protocol_version": 1, "capabilities": {"tools": TOOLS}})
            elif method == "tool.call":
                tool_name = params.get("name", "")
                tool_input = params.get("input", params.get("arguments", {})) or {}
                try:
                    text = dispatch_tool(tool_name, tool_input)
                    _ok(req_id, {"content": text})
                except Exception as e:  # noqa: BLE001
                    _err(req_id, -32000, f"{type(e).__name__}: {e}")
            elif method == "info.get":
                _ok(req_id, {
                    "name": "weather-lens",
                    "version": "0.1.0",
                    "description": "Minimal weather tool via open-meteo API",
                })
            elif method == "hook.handle":
                _ok(req_id, {"action": "continue"})
            elif method == "shutdown":
                _ok(req_id, {})
                break
            else:
                if req_id is not None:
                    _err(req_id, -32601, f"Method not found: {method}")
        except Exception as e:  # noqa: BLE001
            if req_id is not None:
                _err(req_id, -32000, str(e))


if __name__ == "__main__":
    main()
