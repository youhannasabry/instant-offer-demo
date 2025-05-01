document.getElementById('offer-form').addEventListener('submit', async e => {
    e.preventDefault();
    const address = document.getElementById('address').value;
    const sqft = document.getElementById('sqft').value;
    const res = await fetch('/api/offer', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ address, sqft })
    });
    const data = await res.json();
    const resultDiv = document.getElementById('result');
    const compsDiv = document.getElementById('comps');
    if(data.error){
      resultDiv.innerHTML = `<p style="color:red">Error: ${data.error}</p>`;
      compsDiv.innerHTML = '';
    } else {
      resultDiv.innerHTML =
        `<p><strong>Raw Valuation:</strong> $${data.rawValuation}</p>` +
        `<p><strong>Offer:</strong> $${data.offer}</p>` +
        `<p><strong>Fee:</strong> ${(data.feePct*100).toFixed(0)}%</p>` +
        `<p><strong>Margin:</strong> ${(data.marginPct*100).toFixed(0)}%</p>` +
        `<p><strong>Confidence Score:</strong> ${data.confidenceScore}%</p>`;
      compsDiv.innerHTML =
        '<h3>Comps Used:</h3><ul>' +
        data.compsUsed.map(c => `<li>${c.address}: $${c.sale_price} (${c.living_area} sqft) - ${c.distance.toFixed(2)} mi</li>`).join('') +
        '</ul>';
    }
  });
  