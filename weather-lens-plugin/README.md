# weather-lens

Synaps CLI plugin that adds a **`get_weather`** tool — live current conditions
for any city or place, powered by the free [open-meteo](https://open-meteo.com/)
API. No API key, no dependencies, no venv. Python stdlib only.

## Installed capability

### Tool: `get_weather`

```text
weather-lens:get_weather
```

Input schema:

```json
{
  "location": "City or place name, e.g. 'Tokyo' or 'Newark, NJ'."
}
```

Returns a single human-readable line:

```
Weather in Tokyo, Tokyo, Japan: partly cloudy, 28°C. Humidity 72%, wind 14 km/h.
```

Data source: [open-meteo.com](https://open-meteo.com/) geocoding + forecast APIs
(WMO weather code table, `temperature_2m`, `relative_humidity_2m`, `wind_speed_10m`).

## Install

Install via Synaps `/plugins` marketplace or copy the bundle into
`~/.synaps-cli/plugins/weather-lens/`. No setup step required — the extension
starts immediately on the next Synaps session.

```
~/.synaps-cli/plugins/weather-lens/
├── .synaps-plugin/plugin.json
└── extensions/main.py
```

## Requirements

- Python 3 (stdlib only — `json`, `urllib.request`, `urllib.parse`)
- Internet access to `geocoding-api.open-meteo.com` and `api.open-meteo.com`

## Protocol

Content-Length-framed JSON-RPC over stdio (protocol version 1).
Responds to `initialize`, `tool.call`, `info.get`, `hook.handle`, and `shutdown`.

## Safety

No credentials, no disk writes, no local state. All network I/O is outbound
GET requests to open-meteo.com over HTTPS.
