const PANEL_WATTS = 400;
const EFFICIENCY = 0.8;
let map, marker, currentData = null;
let searchHistory = JSON.parse(localStorage.getItem('solarHistory')) || [];

window.onload = function() {
    // Inizializzazione Mappa
    map = L.map('map').setView([41.8719, 12.5674], 6);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { 
        attribution: '&copy; OpenStreetMap' 
    }).addTo(map);
    
    // Forza il ricalcolo dimensioni (importante per embed)
    setTimeout(() => { map.invalidateSize(); }, 500);

    updateHistoryUI();
    
    // Gestione Clic sul tasto Cerca (icona lente)
    document.getElementById('calc-btn').onclick = () => {
        const cityValue = document.getElementById('city-input').value;
        if (cityValue) startNewCalculation(cityValue);
    };

    // Gestione tasto "Invio" nell'input di testo
    document.getElementById('city-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const cityValue = document.getElementById('city-input').value;
            if (cityValue) startNewCalculation(cityValue);
        }
    });

    document.getElementById('target-kwh').onchange = () => refreshCalculation();
    document.getElementById('calc-strategy').onchange = () => refreshCalculation();
    document.getElementById('download-report').onclick = downloadReport;
};

function refreshCalculation() {
    const city = document.getElementById('city-name').innerText;
    if(city !== "SELECT CITY") startNewCalculation(city, true);
}

// Parametro isRefresh per evitare di pulire l'input o duplicare cronologia durante i cambi target
async function startNewCalculation(city, isRefresh = false) {
    if (!city || city === "SELECT CITY") return;

    const targetKwh = parseFloat(document.getElementById('target-kwh').value);
    const strategy = document.getElementById('calc-strategy').value;

    try {
        const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=it&format=json`);
        const geoData = await geoRes.json();
        if (!geoData.results) return alert("Città non trovata");

        const { latitude, longitude, name } = geoData.results[0];

        const solarRes = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${latitude}&longitude=${longitude}&start_date=2023-01-01&end_date=2023-12-31&daily=shortwave_radiation_sum&timezone=auto`);
        const data = await solarRes.json();

        // Calcoli medie
        const annualSum = data.daily.shortwave_radiation_sum.reduce((a, b) => a + b, 0);
        const avgIrr = (annualSum / 365 / 3.6);
        const decAvg = (data.daily.shortwave_radiation_sum.slice(334, 365).reduce((a,b)=>a+b,0) / 31 / 3.6);
        const juneAvg = (data.daily.shortwave_radiation_sum.slice(151, 181).reduce((a,b)=>a+b,0) / 30 / 3.6);

        // Strategia di dimensionamento
        const referenceIrr = (strategy === 'winter') ? decAvg : avgIrr;
        
        const kwp = (targetKwh / referenceIrr / EFFICIENCY).toFixed(2);
        const panels = Math.ceil((kwp * 1000) / PANEL_WATTS);
        const tilt = Math.round(latitude * 0.76 + 3.1);

        // Salvataggio dati per report
        currentData = { name, avgIrr, decAvg, juneAvg, kwp, panels, targetKwh, tilt, strategy };

        // Aggiornamento UI
        document.getElementById('city-name').innerText = name.toUpperCase();
        document.getElementById('irradiance-val').innerText = avgIrr.toFixed(2);
        document.getElementById('peak-power-val').innerText = kwp;
        document.getElementById('panels-count').innerText = panels;
        document.getElementById('june-val').innerText = juneAvg.toFixed(2);
        document.getElementById('dec-val').innerText = decAvg.toFixed(2);
        document.getElementById('tilt-val').innerText = tilt + "°";

        // Gestione Mappa
        if (marker) map.removeLayer(marker);
        map.flyTo([latitude, longitude], 11);
        marker = L.marker([latitude, longitude]).addTo(map).bindPopup(`<b>${name}</b>`).openPopup();

        // Pulizia e cronologia
        if (!isRefresh) {
            document.getElementById('city-input').value = "";
            addToHistory(name);
        }

    } catch (err) { 
        console.error(err); 
        alert("Errore nel recupero dati. Riprova.");
    }
}

function downloadReport() {
    if (!currentData) return alert("Esegui prima un calcolo!");
    
    const text = `
SOLAR AUTHORITY - REPORT TECNICO
---------------------------------
Città: ${currentData.name}
Strategia: ${currentData.strategy === 'winter' ? 'Copertura Invernale' : 'Media Annuale'}
Target Giornaliero: ${currentData.targetKwh} kWh

RISULTATI:
- Potenza di Picco: ${currentData.kwp} kWp
- Numero Pannelli (400W): ${currentData.panels} unità
- Inclinazione Consigliata: ${currentData.tilt}°

DATI IRREDIANCE (kWh/m²):
- Media Annuale: ${currentData.avgIrr.toFixed(2)}
- Picco Giugno: ${currentData.juneAvg.toFixed(2)}
- Minimo Dicembre: ${currentData.decAvg.toFixed(2)}

Report generato il: ${new Date().toLocaleDateString()}
    `;

    const element = document.createElement('a');
    element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
    element.setAttribute('download', `Report_Solar_${currentData.name}.txt`);
    element.style.display = 'none';
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
}

function addToHistory(name) {
    if (!searchHistory.includes(name)) {
        searchHistory.unshift(name);
        if (searchHistory.length > 5) searchHistory.pop();
        localStorage.setItem('solarHistory', JSON.stringify(searchHistory));
        updateHistoryUI();
    }
}

function updateHistoryUI() {
    const container = document.getElementById('history-list');
    if(!container) return;
    container.innerHTML = '';
    searchHistory.forEach(city => {
        const btn = document.createElement('button');
        btn.className = "px-2 py-1 bg-white border border-slate-200 rounded text-[10px] font-bold hover:bg-slate-100 transition";
        btn.innerText = city.toUpperCase();
        btn.onclick = () => startNewCalculation(city);
        container.appendChild(btn);
    });
}