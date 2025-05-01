require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const GEOCODER_KEY   = process.env.GEOCODER_API_KEY;
const COMPS_PROVIDER = (process.env.COMPS_PROVIDER || 'attom').toLowerCase();
const ESTATED_KEY    = process.env.ESTATED_KEY;
const ATTOM_KEY      = process.env.ATTOM_KEY;

// 1. Geocode free-text address → { lat, lng }
async function geocode(address) {
  const resp = await axios.get('https://us1.locationiq.com/v1/search.php', {
    params: { key: GEOCODER_KEY, q: address, format: 'json', limit: 1 }
  });
  if (!resp.data || resp.data.length === 0) throw new Error('Geocoding failed');
  return { lat: parseFloat(resp.data[0].lat), lng: parseFloat(resp.data[0].lon) };
}

// 2a. Fetch comps via Estated API
async function fetchCompsEstated(lat, lng) {
  const resp = await axios.get('https://api.estated.com/property/v3', {
    params: {
      token: ESTATED_KEY,
      latitude: lat,
      longitude: lng,
      radius_miles: 1,
      limit: 10,
      sold_last_6_months: true
    }
  });
  const props = resp.data.properties || [];
  return props
    .map(p => ({
      address: p.address.formatted,
      sale_price: p.last_sale?.amount,
      living_area: p.building.size.living_area,
      sale_date: p.last_sale?.date,
      distance: p.distance
    }))
    .filter(c => c.sale_price && c.living_area);
}

// 2b. Fetch comps via ATTOM Data API (address endpoint)
async function fetchCompsAttom(lat, lng, address) {
  let street, city, state, zip;
  try {
    const parts = address.split(',');
    street = parts[0].trim();
    city = parts[1].trim();
    const [st, zp] = parts[2].trim().split(' ');
    state = st;
    zip = zp;
  } catch {
    throw new Error('For ATTOM provider, use format: "Street, City, State Zip"');
  }
  const country = 'US';
  const url = `https://api.gateway.attomdata.com/property/v2/salescomparables/address/${encodeURIComponent(street)}/${encodeURIComponent(city)}/${encodeURIComponent(country)}/${encodeURIComponent(state)}/${encodeURIComponent(zip)}`;
  const resp = await axios.get(url, {
    headers: { 'Accept': 'application/json', 'APIKey': ATTOM_KEY },
    params: {
      searchType: 'Radius',
      minComps: 3,
      maxComps: 10,
      miles: 1,
      saleDateRange: 6
    }
  });
  const subjectSection = resp.data.RESPONSE_GROUP?.RESPONSE?.RESPONSE_DATA?.PROPERTY_INFORMATION_RESPONSE_ext?.SUBJECT_PROPERTY_ext;
  if (!subjectSection || !subjectSection.PROPERTY) throw new Error('No PROPERTY data in ATTOM response');
  const props = Array.isArray(subjectSection.PROPERTY) ? subjectSection.PROPERTY : [subjectSection.PROPERTY];
  const compsRaw = props.slice(1).map(item => item.COMPARABLE_PROPERTY_ext).filter(Boolean);
  return compsRaw.map(p => ({
    address: p['@_StreetAddress'],
    sale_price: parseFloat(p.SALES_HISTORY['@PropertySalesAmount']),
    living_area: parseFloat(p.STRUCTURE['@GrossLivingAreaSquareFeetCount']),
    sale_date: p.SALES_HISTORY['@PropertySalesDate'] || p.SALES_HISTORY['@TransferDate_ext'],
    distance: parseFloat(p['@DistanceFromSubjectPropertyMilesCount'])
  })).filter(c => c.sale_price && c.living_area);
}

async function fetchComps(lat, lng, address) {
  if (COMPS_PROVIDER === 'attom') return await fetchCompsAttom(lat, lng, address);
  return await fetchCompsEstated(lat, lng);
}

// 3. Calculate weighted avg $/sqft, valuation, offer & confidence score
function calculateOffer(comps, sqft) {
  const weights = comps.map(c => 1 / ((c.distance || 0) + 0.1));
  const ppsfList = comps.map(c => c.sale_price / c.living_area);
  const weightedSum = ppsfList.reduce((sum, v, i) => sum + v * weights[i], 0);
  const weightTotal = weights.reduce((sum, w) => sum + w, 0);
  const weightedPpsf = weightedSum / weightTotal;
  const rawValuation = weightedPpsf * sqft;
  const feePct = 0.06;
  const marginPct = 0.05;
  const offer = rawValuation * (1 - feePct - marginPct);

  // Compute coefficient of variation
  const mean = weightedPpsf;
  const variance = ppsfList.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / ppsfList.length;
  const sd = Math.sqrt(variance);
  const cv = sd / mean;
  // Confidence score = (1 - cv) * 100, clamped 0–100
  const rawScore = (1 - cv) * 100;
  const confidenceScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  return {
    rawValuation: rawValuation.toFixed(2),
    offer: offer.toFixed(2),
    feePct,
    marginPct,
    confidenceScore
  };
}

// API: POST /api/offer
app.post('/api/offer', async (req, res) => {
  try {
    const { address, sqft } = req.body;
    if (!address || !sqft || isNaN(sqft)) throw new Error('Invalid input');
    const { lat, lng } = await geocode(address);
    const comps = await fetchComps(lat, lng, address);
    if (!comps || comps.length < 3) throw new Error('Not enough comps found');
    const result = calculateOffer(comps, Number(sqft));
    res.json({ address, sqft, ...result, compsUsed: comps });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));