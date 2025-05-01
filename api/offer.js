const axios = require('axios');
const Cors = require('cors');

// Initialize CORS middleware
const cors = Cors({ origin: true });

// Helper to run middleware
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) reject(result);
      else resolve(result);
    });
  });
}

// Environment variables
const GEOCODER_KEY = process.env.GEOCODER_API_KEY;
const COMPS_PROVIDER = (process.env.COMPS_PROVIDER || 'estated').toLowerCase();
const ESTATED_KEY = process.env.ESTATED_KEY;
const ATTOM_KEY = process.env.ATTOM_KEY;

// Geocode function
async function geocode(address) {
  const resp = await axios.get('https://us1.locationiq.com/v1/search.php', {
    params: { key: GEOCODER_KEY, q: address, format: 'json', limit: 1 }
  });
  if (!resp.data?.length) throw new Error('Geocoding failed');
  return { lat: +resp.data[0].lat, lng: +resp.data[0].lon };
}

// Fetch comps from Estated
async function fetchCompsEstated(lat, lng) {
  const resp = await axios.get('https://api.estated.com/property/v3', {
    params: { token: ESTATED_KEY, latitude: lat, longitude: lng, radius_miles:1, limit:10, sold_last_6_months:true }
  });
  return (resp.data.properties || []).map(p => ({
    address: p.address.formatted,
    sale_price: p.last_sale?.amount,
    living_area: p.building.size.living_area,
    distance: p.distance
  })).filter(c => c.sale_price && c.living_area);
}

// Fetch comps from ATTOM
async function fetchCompsAttom(lat, lng, address) {
  const [street, city, stateZip] = address.split(',').map(s => s.trim());
  const [state, zip] = stateZip.split(' ');
  const url = `https://api.gateway.attomdata.com/property/v2/salescomparables/address/${encodeURIComponent(street)}/${encodeURIComponent(city)}/US/${state}/${zip}`;
  const resp = await axios.get(url, {
    headers: { 'Accept':'application/json', 'APIKey': ATTOM_KEY },
    params: { searchType:'Radius', minComps:3, maxComps:10, miles:1, saleDateRange:6 }
  });
  const section = resp.data.RESPONSE_GROUP?.RESPONSE?.RESPONSE_DATA?.PROPERTY_INFORMATION_RESPONSE_ext?.SUBJECT_PROPERTY_ext;
  const props = Array.isArray(section.PROPERTY) ? section.PROPERTY : [section.PROPERTY];
  return props.slice(1).map(item => item.COMPARABLE_PROPERTY_ext).map(p => ({
    address: p['@_StreetAddress'],
    sale_price: +p.SALES_HISTORY['@PropertySalesAmount'],
    living_area: +p.STRUCTURE['@GrossLivingAreaSquareFeetCount'],
    distance: +p['@DistanceFromSubjectPropertyMilesCount']
  })).filter(c => c.sale_price && c.living_area);
}

// Main function
module.exports = async (req, res) => {
  await runMiddleware(req, res, cors);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { address, sqft } = req.body;
    if (!address || !sqft || isNaN(sqft)) throw new Error('Invalid input');
    const { lat, lng } = await geocode(address);
    const comps = (COMPS_PROVIDER === 'attom')
      ? await fetchCompsAttom(lat, lng, address)
      : await fetchCompsEstated(lat, lng);
    if (comps.length < 3) throw new Error('Not enough comparables');
    // Calculate weighted mean ppsf
    const weights = comps.map(c => 1 / (c.distance + 0.1));
    const ppsf = comps.map(c => c.sale_price / c.living_area);
    const sumW = weights.reduce((a,b) => a+b, 0);
    const meanPpsf = ppsf.reduce((a,v,i) => a + v*weights[i], 0) / sumW;
    const rawVal = meanPpsf * sqft;
    const fee=0.06, margin=0.05;
    const offer = rawVal * (1-fee-margin);
    const variance = ppsf.reduce((a,v) => a + (v-meanPpsf)**2,0) / ppsf.length;
    const sd = Math.sqrt(variance), cv = sd/meanPpsf;
    const score = Math.max(0, Math.min(100, Math.round((1-cv)*100)));
    res.json({ rawValuation: rawVal.toFixed(2), offer: offer.toFixed(2), feePct: fee, marginPct: margin, confidenceScore: score, compsUsed: comps });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
};