// Maps a user's state to its REAL benefits application portal, so the AI autofill
// agent opens the actual multi-step application (behind the state's login) rather
// than a federal info/directory page.
//
// Most states run ONE combined portal that handles Medicaid, SNAP, TANF, cash,
// CHIP, etc. We open that portal for those state-administered benefits; the agent
// then hits the portal's sign-in (login hand-off), and once the user is in and on
// the application, fills it from their saved info.
//
// This is a curated starter map of widely-used official portals. States not
// listed fall back to the benefit's federal apply link. URLs are easy to correct
// here as portals change.

// Benefits that are applied for through a state's combined benefits portal.
export const STATE_ADMINISTERED = new Set<string>([
  "medicaid",
  "rma", // refugee medical assistance — same state apparatus as Medicaid
  "chip",
  "snap",
  "tanf",
  "rca", // refugee cash assistance — applied via the state
  "liheap",
  "childcare_ccdf",
]);

interface Portal { url: string; name: string }

export const STATE_PORTALS: Record<string, Portal> = {
  AL: { url: "https://www.mybenefits.alabama.gov", name: "Alabama MyBenefits" },
  AK: { url: "https://aries.alaska.gov", name: "Alaska ARIES" },
  AZ: { url: "https://www.healthearizonaplus.gov", name: "Health-e-Arizona Plus" },
  AR: { url: "https://access.arkansas.gov", name: "Arkansas Access" },
  CA: { url: "https://benefitscal.com", name: "BenefitsCal" },
  CO: { url: "https://coloradopeak.secure.force.com", name: "Colorado PEAK" },
  CT: { url: "https://www.connect.ct.gov", name: "ConneCT" },
  DE: { url: "https://assist.dhss.delaware.gov", name: "Delaware ASSIST" },
  DC: { url: "https://districtdirect.dc.gov", name: "District Direct" },
  FL: { url: "https://www.myaccess.myflfamilies.com", name: "ACCESS Florida" },
  GA: { url: "https://gateway.ga.gov", name: "Georgia Gateway" },
  HI: { url: "https://hspeed.hawaii.gov", name: "Hawaii HSPEED" },
  ID: { url: "https://idalink.idaho.gov", name: "Idaho idalink" },
  IL: { url: "https://abe.illinois.gov", name: "Illinois ABE" },
  IN: { url: "https://fssabenefits.in.gov", name: "Indiana FSSA Benefits" },
  IA: { url: "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/guestLogin", name: "Iowa HHS Services (guest apply)" },
  KS: { url: "https://www.applyforbenefits.ks.gov", name: "Kansas Benefits" },
  KY: { url: "https://kynect.ky.gov", name: "Kentucky kynect" },
  LA: { url: "https://sspweb.dcfs.la.gov", name: "Louisiana CAFÉ" },
  ME: { url: "https://mymaineconnection.maine.gov", name: "My Maine Connection" },
  MD: { url: "https://mymdthink.maryland.gov", name: "Maryland MDTHINK" },
  MA: { url: "https://dtaconnect.eohhs.mass.gov", name: "DTA Connect" },
  MI: { url: "https://newmibridges.michigan.gov", name: "MI Bridges" },
  MN: { url: "https://mnbenefits.mn.gov", name: "MNbenefits" },
  MS: { url: "https://www.access.ms.gov", name: "Mississippi Access" },
  MO: { url: "https://mydss.mo.gov", name: "Missouri myDSS" },
  MT: { url: "https://apply.mt.gov", name: "Montana Apply" },
  NE: { url: "https://iserve.nebraska.gov", name: "Nebraska iServe" },
  NV: { url: "https://accessnevada.dwss.nv.gov", name: "Access Nevada" },
  NH: { url: "https://nheasy.nh.gov", name: "NH EASY" },
  NJ: { url: "https://www.njhelps.org", name: "NJ Helps" },
  NM: { url: "https://www.yes.state.nm.us", name: "New Mexico YES" },
  NY: { url: "https://mybenefits.ny.gov", name: "myBenefits New York" },
  NC: { url: "https://epass.nc.gov", name: "North Carolina ePASS" },
  ND: { url: "https://www.applyforbenefits.nd.gov", name: "North Dakota Benefits" },
  OH: { url: "https://benefits.ohio.gov", name: "Ohio Benefits" },
  OK: { url: "https://www.okdhslive.org", name: "OKDHSLive" },
  OR: { url: "https://one.oregon.gov", name: "Oregon ONE" },
  PA: { url: "https://www.compass.state.pa.us", name: "Pennsylvania COMPASS" },
  RI: { url: "https://healthyrhode.ri.gov", name: "HealthyRhode" },
  SC: { url: "https://apply.scdhhs.gov", name: "South Carolina Apply" },
  SD: { url: "https://dss.sd.gov", name: "South Dakota DSS" },
  TN: { url: "https://onedhs.tn.gov", name: "Tennessee One DHS" },
  TX: { url: "https://www.yourtexasbenefits.com", name: "Your Texas Benefits" },
  UT: { url: "https://jobs.utah.gov/mycase", name: "Utah myCase" },
  VT: { url: "https://mybenefits.vermont.gov", name: "MyBenefits Vermont" },
  VA: { url: "https://commonhelp.virginia.gov", name: "Virginia CommonHelp" },
  WA: { url: "https://www.washingtonconnection.org", name: "Washington Connection" },
  WV: { url: "https://www.wvpath.wv.gov", name: "West Virginia PATH" },
  WI: { url: "https://access.wisconsin.gov", name: "Wisconsin ACCESS" },
  WY: { url: "https://benefits.wyo.gov", name: "Wyoming Benefits" },
};

// The URL the agent should open for a benefit: the user's state portal for
// state-administered benefits (when we know the state), else the federal link.
export function applyUrlFor(benefitId: string, state: string | null | undefined, fallback: string): string {
  if (state && STATE_ADMINISTERED.has(benefitId)) {
    const portal = STATE_PORTALS[state.toUpperCase()];
    if (portal) return portal.url;
  }
  return fallback;
}

export function portalNameFor(state: string | null | undefined): string | undefined {
  if (!state) return undefined;
  return STATE_PORTALS[state.toUpperCase()]?.name;
}
