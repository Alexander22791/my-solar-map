const PANEL_WATTS = 400;
const EFFICIENCY = 0.8;
let map, marker, currentData = null;
const statusMessage = document.getElementById('status-message');
const mapMessage = document.getElementById('map-message');

function readSearchHistory() {
    try {
        const saved = JSON.parse(localStorage.getItem('solarHistory') || '[]');
        return Array.isArray(saved) ? saved.filter((city) => typeof city === 'string') : [];
    } catch (error) {
        console.warn('Impossibile leggere la cronologia locale:', error);
        return [];
    }
}

let searchHistory = readSearchHistory();

function showStatus(message) {
    statusMessage.textContent = message;
    statusMessage.hidden = false;
}

function clearStatus() {
    statusMessage.textContent = '';
    statusMessage.hidden = true;
}

function showMapError(message) {
    mapMessage.textContent = message;
    mapMessage.hidden = false;
}

function initialize() {
    if (typeof maplibregl === 'undefined') {
        showMapError('La libreria della mappa non è stata caricata. Controlla la connessione e ricarica la pagina.');
    } else {
        try {
            map = new maplibregl.Map({
                container: 'map',
                style: 'https://tiles.openfreemap.org/styles/liberty',
                center: [12.5674, 41.8719],
                zoom: 6,
            });
            map.addControl(new maplibregl.NavigationControl(), 'top-right');

            map.on('load', () => {
                map.resize();
                mapMessage.hidden = true;
            });
            map.on('error', (event) => {
                console.error('Errore MapLibre/OpenFreeMap:', event.error || event);
                showMapError('La mappa o alcuni suoi dati non sono riusciti a caricarsi. Verifica la connessione e riprova.');
            });

            // Ricalcola le dimensioni dopo il layout iniziale e quando cambia la finestra.
            window.setTimeout(() => map?.resize(), 300);
            window.addEventListener('resize', () => map?.resize());
        } catch (error) {
            console.error('Errore durante l’inizializzazione della mappa:', error);
            showMapError('Impossibile inizializzare la mappa. Ricarica la pagina; se il problema continua, riprova più tardi.');
        }
    }

    updateHistoryUI();

    document.getElementById('calc-btn').addEventListener('click', submitCity);
    document.getElementById('city-input').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submitCity();
    });
    document.getElementById('target-kwh').addEventListener('change', refreshCalculation);
    document.getElementById('calc-strategy').addEventListener('change', refreshCalculation);
    document.getElementById('download-report').addEventListener('click', downloadReport);
}

function submitCity() {
    const cityValue = document.getElementById('city-input').value.trim();
    if (!cityValue) {
        showStatus('Inserisci il nome di una città per avviare la ricerca.');
        return;
    }
    startNewCalculation(cityValue);
}

async function fetchJson(url, service) {
    let response;
    try {
        response = await fetch(url);
    } catch (error) {
        throw new Error(`Non riesco a raggiungere il servizio dei ${service}. Controlla la connessione e riprova.`);
    }

    if (!response.ok) throw new Error(apiErrorMessage(response.status, service));

    try {
        return await response.json();
    } catch (error) {
        throw new Error(`Il servizio dei ${service} ha inviato una risposta non valida. Riprova più tardi.`);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}

function refreshCalculation() {
    const city = document.getElementById('city-name').innerText;
    if(city !== "SELECT CITY") startNewCalculation(city, true);
}

// Parametro isRefresh per evitare di pulire l'input o duplicare cronologia durante i cambi target
async function startNewCalculation(city, isRefresh = false) {
    if (!city || city === 'SELECT CITY') return;

    clearStatus();

    const targetKwh = parseFloat(document.getElementById('target-kwh').value);
    const strategy = document.getElementById('calc-strategy').value;

    try {
        const geoData = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=it&format=json`, 'geocodifica');
        if (!Array.isArray(geoData.results) || geoData.results.length === 0) {
            showStatus('Città non trovata. Controlla il nome e riprova.');
            return;
        }

        const { latitude, longitude, name } = geoData.results[0];
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !name) {
            throw new Error('La risposta della ricerca della località non è valida. Riprova tra poco.');
        }

        const data = await fetchJson(`https://archive-api.open-meteo.com/v1/archive?latitude=${latitude}&longitude=${longitude}&start_date=2023-01-01&end_date=2023-12-31&daily=shortwave_radiation_sum&timezone=auto`, 'dati solari');
        const radiation = data.daily?.shortwave_radiation_sum;
        if (!Array.isArray(radiation) || radiation.length < 365 || radiation.some((value) => !Number.isFinite(value))) {
            throw new Error('I dati solari ricevuti sono incompleti. Riprova più tardi.');
        }

        // Calcoli medie
        const annualSum = radiation.reduce((a, b) => a + b, 0);
        const avgIrr = (annualSum / 365 / 3.6);
        const decAvg = (radiation.slice(334, 365).reduce((a,b)=>a+b,0) / 31 / 3.6);
        const juneAvg = (radiation.slice(151, 181).reduce((a,b)=>a+b,0) / 30 / 3.6);

        // Strategia di dimensionamento
        const referenceIrr = (strategy === 'winter') ? decAvg : avgIrr;
        if (!Number.isFinite(referenceIrr) || referenceIrr <= 0) {
            throw new Error('I dati di irraggiamento non consentono di calcolare il dimensionamento. Riprova con un’altra località.');
        }
        
        const kwp = targetKwh / referenceIrr / EFFICIENCY;
        const panels = Math.ceil((kwp * 1000) / PANEL_WATTS);
        const tilt = Math.round(latitude * 0.76 + 3.1);

        // Salvataggio dati per report
        currentData = { name, avgIrr, decAvg, juneAvg, kwp, panels, targetKwh, tilt, strategy };

        // Aggiornamento UI
        document.getElementById('city-name').innerText = name.toUpperCase();
        document.getElementById('irradiance-val').innerText = avgIrr.toFixed(2);
        document.getElementById('peak-power-val').innerText = kwp.toFixed(2);
        document.getElementById('panels-count').innerText = panels;
        document.getElementById('june-val').innerText = juneAvg.toFixed(2);
        document.getElementById('dec-val').innerText = decAvg.toFixed(2);
        document.getElementById('tilt-val').innerText = tilt + "°";

        // Gestione Mappa
        if (map) {
            if (marker) marker.remove();
            map.flyTo({ center: [longitude, latitude], zoom: 11 });
            marker = new maplibregl.Marker()
                .setLngLat([longitude, latitude])
                .setPopup(new maplibregl.Popup().setText(name))
                .addTo(map);
            marker.togglePopup();
        }

        // Pulizia e cronologia
        if (!isRefresh) {
            document.getElementById('city-input').value = "";
            addToHistory(name);
        }
        clearStatus();

    } catch (err) { 
        console.error('Errore nel calcolo Solar Map:', err);
        showStatus(err instanceof TypeError
            ? 'Si è verificato un problema imprevisto durante il recupero dei dati. Riprova più tardi.'
            : err.message || 'Errore nel recupero dei dati. Riprova più tardi.');
    }
}

function apiErrorMessage(status, service) {
    if (status === 429) return `Il servizio dei ${service} è momentaneamente molto richiesto. Attendi qualche minuto e riprova.`;
    if (status >= 500) return `Il servizio dei ${service} è temporaneamente non disponibile. Riprova più tardi.`;
    return `Il servizio dei ${service} ha risposto con un errore (${status}). Riprova più tardi.`;
}

function downloadReport() {
    if (!currentData) {
        showStatus('Esegui prima un calcolo per scaricare il report.');
        return;
    }
    
    const text = `
OUTOFTHEGRID SOLAR MAP - REPORT TECNICO
---------------------------------
Città: ${currentData.name}
Strategia: ${currentData.strategy === 'winter' ? 'Copertura Invernale' : 'Media Annuale'}
Target Giornaliero: ${currentData.targetKwh} kWh

RISULTATI:
- Potenza di Picco: ${currentData.kwp.toFixed(2)} kWp
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
        try {
            localStorage.setItem('solarHistory', JSON.stringify(searchHistory));
        } catch (error) {
            console.warn('Impossibile salvare la cronologia locale:', error);
        }
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