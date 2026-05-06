import https from 'https';

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const AUTOSYS_API_KEY = process.env.AUTOSYS_API_KEY;
const REBIL_ORG_NR = process.env.REBIL_ORG_NR || '918320567';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

const PIPELINE_SALG_NY = '726666487';
const PIPELINE_KOMMISJON = '807399646';
const SALG_NY_STAGES = ['188827597', '1117794508', '2331475148', '1214787795'];
const KOMMISJON_EKSKLUDER = ['1151615214', '1911869667'];
const KOMMISJON_LEVERT = '1151615215';

const STAGE_NAVN = {
  '188827597': 'Kontrakt signert',
  '1117794508': 'Lead Signert',
  '2331475148': 'Aktivt salgssteg',
  '1214787795': 'Aktivt salgssteg',
  '1151615215': 'Levert',
  '1151604936': 'På vei inn',
  '1151604938': 'Annonsere',
  '1151604939': 'Annonsert',
  '1151604941': 'Aktivt salgssteg',
};

function sjekkAuth(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/rebil_auth=([^;]+)/);
  return match && match[1] === DASHBOARD_PASSWORD;
}

function httpsRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: r.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function normaliserRegNr(r) {
  if (!r) return null;
  return r.trim().toUpperCase().replace(/\s+/g, '');
}

function erInnenfor24Timer(datoStreng) {
  if (!datoStreng) return false;
  return new Date(datoStreng) >= new Date(Date.now() - 24 * 3600 * 1000);
}

async function hentHubSpotDeals(filterGroups, properties) {
  const deals = [];
  let after;
  do {
    const res = await httpsRequest(
      'https://api.hubapi.com/crm/v3/objects/deals/search',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HUBSPOT_API_KEY}` } },
      { filterGroups, properties, limit: 100, ...(after ? { after } : {}) }
    );
    if (res.status !== 200) throw new Error(`HubSpot feil ${res.status}`);
    deals.push(...(res.body.results || []));
    after = res.body.paging?.next?.after;
  } while (after);
  return deals;
}

async function sjekkAutosys(regNr) {
  if (!AUTOSYS_API_KEY) return null;
  const res = await httpsRequest(
    `https://www.vegvesen.no/ws/no/vegvesen/kjoretoy/felles/datautlevering/enkeltoppslag/kjoretoydata?kjennemerke=${encodeURIComponent(regNr)}`,
    { headers: { 'SVV-Authorization': AUTOSYS_API_KEY, Accept: 'application/json' } }
  );
  if (res.status === 200) return res.body;
  return null;
}

function tolkAutosys(data) {
  if (!data) return { eier: null, erRebil: null, omregistrertDato: null, fraEier: null };
  const ei = data?.kjoretoydataListe?.[0]?.eierregistrering?.sistRegistrertEier || data?.eierregistrering?.sistRegistrertEier || null;
  const ti = data?.kjoretoydataListe?.[0]?.eierregistrering?.tidligereEiere?.[0] || data?.eierregistrering?.tidligereEiere?.[0] || null;
  const orgNr = (ei?.juridiskPerson?.organisasjonsnummer || '').replace(/\s+/g, '');
  const eier = ei?.juridiskPerson?.navn || ei?.person?.etternavn || 'Privat';
  const fraEier = ti?.juridiskPerson?.navn || ti?.person?.etternavn || null;
  const omregistrertDato = ei?.registreringstidspunkt?.substring(0, 10) || null;
  return { eier, erRebil: orgNr === REBIL_ORG_NR, omregistrertDato, fraEier };
}

export default async function handler(req, res) {
  if (!sjekkAuth(req)) return res.status(401).json({ error: 'Ikke innlogget' });

  try {
    const salgNyRaw = await hentHubSpotDeals(
      SALG_NY_STAGES.map(stageId => ({
        filters: [
          { propertyName: 'pipeline', operator: 'EQ', value: PIPELINE_SALG_NY },
          { propertyName: 'dealstage', operator: 'EQ', value: stageId },
          { propertyName: 'reg_nr', operator: 'HAS_PROPERTY' },
        ]
      })),
      ['dealname', 'dealstage', 'reg_nr', 'hs_lastmodifieddate']
    );

    const kommisjonRaw = await hentHubSpotDeals(
      [{ filters: [
        { propertyName: 'pipeline', operator: 'EQ', value: PIPELINE_KOMMISJON },
        { propertyName: 'reg_nr', operator: 'HAS_PROPERTY' },
        { propertyName: 'dealstage', operator: 'NOT_IN', values: KOMMISJON_EKSKLUDER },
      ]}],
      ['dealname', 'dealstage', 'reg_nr', 'hs_lastmodifieddate']
    );

    const kommisjonFiltrert = kommisjonRaw.filter(d => {
      if (d.properties.dealstage === KOMMISJON_LEVERT) {
        return erInnenfor24Timer(d.properties.hs_lastmodifieddate);
      }
      return true;
    });

    const deals = [];

    for (const d of salgNyRaw) {
      const regNr = normaliserRegNr(d.properties.reg_nr);
      if (!regNr) continue;
      const autosys = await sjekkAutosys(regNr);
      const { eier, erRebil, omregistrertDato, fraEier } = tolkAutosys(autosys);
      deals.push({
        dealId: d.id,
        regNr,
        navn: d.properties.dealname || regNr,
        pipeline: 'salgny',
        stage: STAGE_NAVN[d.properties.dealstage] || d.properties.dealstage,
        status: !AUTOSYS_API_KEY ? 'ukjent' : erRebil ? 'ok' : 'avvik',
        omregistrertDato: omregistrertDato || null,
        fraEier: fraEier || null,
        eier: eier || null,
      });
    }

    for (const d of kommisjonFiltrert) {
      const regNr = normaliserRegNr(d.properties.reg_nr);
      if (!regNr) continue;
      const autosys = await sjekkAutosys(regNr);
      const { eier, omregistrertDato, fraEier } = tolkAutosys(autosys);
      const nyligOmreg = omregistrertDato && erInnenfor24Timer(omregistrertDato + 'T00:00:00');
      deals.push({
        dealId: d.id,
        regNr,
        navn: d.properties.dealname || regNr,
        pipeline: 'kommisjon',
        stage: STAGE_NAVN[d.properties.dealstage] || d.properties.dealstage,
        status: !AUTOSYS_API_KEY ? 'ukjent' : nyligOmreg ? 'komm' : 'ok',
        omregistrertDato: omregistrertDato || null,
        fraEier: fraEier || null,
        eier: eier || null,
      });
    }

    res.status(200).json({ deals, autosysAktiv: !!AUTOSYS_API_KEY });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
