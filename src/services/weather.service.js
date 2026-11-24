/**
 * District weather for the diagnosis prompt — Phase 2 spec, Module 01.
 *
 * Contract: **this service never fails a scan.** Every public function
 * resolves to a snapshot or to null. A missing API key, a timeout, a 429 or
 * a district we can't geocode all degrade to "no weather context", and the
 * prompt simply omits that line. Diagnosis accuracy drops a little; the
 * planter's scan still works.
 */

import { WeatherSnapshot } from '../models/WeatherSnapshot.js';
import { env } from '../config/env.js';

const OWM_URL = 'https://api.openweathermap.org/data/2.5/weather';
const FETCH_TIMEOUT_MS = 4000;
const SAMPLE_WINDOW_MS = 7 * 86_400_000;

/**
 * Cardamom-growing districts, pinned to the plantation belt rather than the
 * district HQ — Idukki's HQ sits lower and drier than the Kumily/Vandanmedu
 * cardamom hills, and rainfall is what we care about. Anything not listed
 * falls back to OpenWeather's own "{district},Kerala,IN" lookup.
 */
const DISTRICT_COORDS = {
  idukki: { lat: 9.8497, lon: 77.1025 },      // Kumily / Vandanmedu belt
  wayanad: { lat: 11.6854, lon: 76.1320 },    // Kalpetta
  palakkad: { lat: 10.7867, lon: 76.6548 },
  kottayam: { lat: 9.5916, lon: 76.5222 },
  ernakulam: { lat: 10.0261, lon: 76.3125 },
  thrissur: { lat: 10.5276, lon: 76.2144 },
  pathanamthitta: { lat: 9.2648, lon: 76.7870 },
  kollam: { lat: 8.8932, lon: 76.6141 },
  kannur: { lat: 11.8745, lon: 75.3704 },
  kozhikode: { lat: 11.2588, lon: 75.7804 },
  malappuram: { lat: 11.0510, lon: 76.0711 },
  kasaragod: { lat: 12.4996, lon: 74.9869 },
  alappuzha: { lat: 9.4981, lon: 76.3388 },
  thiruvananthapuram: { lat: 8.5241, lon: 76.9366 },
};

function cacheKey(district) {
  return (district ?? '').trim().toLowerCase();
}

function isFresh(snapshot) {
  if (!snapshot?.fetchedAt) return false;
  const ageMs = Date.now() - snapshot.fetchedAt.getTime();
  return ageMs < env.weather.cacheTtlMinutes * 60_000;
}

/** Build the OpenWeather query for a district, by coords where we have them. */
function queryFor(district) {
  const coords = DISTRICT_COORDS[cacheKey(district)];
  const params = new URLSearchParams({
    appid: env.weather.apiKey,
    units: 'metric',
  });
  if (coords) {
    params.set('lat', String(coords.lat));
    params.set('lon', String(coords.lon));
  } else {
    params.set('q', `${district},Kerala,IN`);
  }
  return `${OWM_URL}?${params.toString()}`;
}

async function fetchFromProvider(district) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(queryFor(district), { signal: controller.signal });
    if (!res.ok) throw new Error(`OpenWeather ${res.status}`);
    const j = await res.json();
    return {
      condition: j.weather?.[0]?.main ?? '',
      description: j.weather?.[0]?.description ?? '',
      tempC: j.main?.temp ?? null,
      humidity: j.main?.humidity ?? null,
      // OpenWeather omits `rain` entirely when it isn't raining.
      rain3hMm: j.rain?.['3h'] ?? j.rain?.['1h'] ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Current snapshot for [district], refreshing from OpenWeather only when the
 * cached copy has aged out.
 *
 * On a refresh failure an existing stale snapshot is returned rather than
 * nothing — week-old rainfall still beats no seasonal signal at all.
 *
 * @returns {Promise<import('../models/WeatherSnapshot.js').WeatherSnapshot|null>}
 */
export async function getDistrictWeather(district) {
  const key = cacheKey(district);
  if (!key || !env.weather.apiKey) return null;

  let snapshot = null;
  try {
    snapshot = await WeatherSnapshot.findOne({ district: key });
    if (isFresh(snapshot)) return snapshot;
  } catch {
    return null; // DB trouble — not worth failing a scan over.
  }

  let reading;
  try {
    reading = await fetchFromProvider(district);
  } catch (err) {
    if (snapshot) {
      // Keep serving the stale copy; record why it didn't refresh.
      snapshot.lastError = String(err.message ?? err).slice(0, 200);
      await snapshot.save().catch(() => {});
      return snapshot;
    }
    return null;
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - SAMPLE_WINDOW_MS);
  const kept = (snapshot?.samples ?? []).filter((s) => s.at > cutoff);
  kept.push({
    at: now,
    rain3hMm: reading.rain3hMm,
    condition: reading.condition,
    tempC: reading.tempC,
    humidity: reading.humidity,
  });

  try {
    return await WeatherSnapshot.findOneAndUpdate(
      { district: key },
      {
        $set: {
          district: key,
          fetchedAt: now,
          ...reading,
          samples: kept,
          lastError: '',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  } catch {
    return snapshot; // Write failed; the fetched reading is still unused.
  }
}

/**
 * One line of weather for the prompt, or null when we have nothing useful.
 * Kept here so the wording lives next to the data that shapes it.
 */
export function describeWeather(snapshot) {
  if (!snapshot) return null;
  const { totalMm, coverageDays, partial } = snapshot.rainfallWindow();
  const bits = [];

  if (snapshot.description) bits.push(`currently ${snapshot.description}`);
  if (snapshot.tempC != null) bits.push(`${Math.round(snapshot.tempC)}°C`);
  if (snapshot.humidity != null) bits.push(`${snapshot.humidity}% humidity`);

  const days = Math.max(1, Math.round(coverageDays));
  const rain =
    partial
      ? `${totalMm.toFixed(1)} mm rain recorded over the last ${days} day(s) ` +
        '(partial history — treat as a floor, not a total)'
      : `${totalMm.toFixed(1)} mm rain over the last 7 days`;
  bits.push(rain);

  const ageHours = Math.round((Date.now() - snapshot.fetchedAt.getTime()) / 3.6e6);
  if (ageHours > 24) bits.push(`reading is ${ageHours}h old`);

  return bits.join(', ');
}
