// SPDX-License-Identifier: CC0-1.0
/**
 * First-party `official-health` list (ADR-0016: first-party lists are CC0-1.0). Hosts and
 * host+path prefixes of official health authorities (ministries, public-health agencies,
 * medicines regulators) and a few long-standing clinical reference sites, one ecosystem per
 * block. Kind `official`: it only labels results as official; it never hides anything.
 *
 * Evidence, per entry: the trailing comment names the Wikidata item whose "official website"
 * (P856) is this domain, or how the site's identity was checked instead. Every host was also
 * checked to resolve on 2026-10-31; several sit behind bot protection, which the Wikidata
 * record or the government-only registry (`.gov`, `.gov.au`, `.go.jp`, …) backs up.
 *
 * Contributions: add a public link showing the site belongs to the health authority (its
 * Wikidata P856, or a page of the authority naming the domain).
 */
export const OFFICIAL_HEALTH_ID = 'official-health'

export const OFFICIAL_HEALTH: readonly string[] = [
  // International organisations
  'who.int', // Q7817 World Health Organization (also covers iris.who.int, the regional offices)
  'paho.org', // Q1856835 Pan American Health Organization (WHO Americas)
  'unaids.org', // Q588982 UNAIDS
  'africacdc.org', // Q88234914 Africa CDC
  // European Union agencies
  'ema.europa.eu', // Q130146 European Medicines Agency
  'ecdc.europa.eu', // Q918501 European Centre for Disease Prevention and Control
  'efsa.europa.eu', // Q516521 European Food Safety Authority
  'health.ec.europa.eu', // European Commission, DG Health and Food Safety (site title "Public Health")
  // United States: Department of Health and Human Services and its agencies
  'hhs.gov', // Q942326 Department of Health and Human Services
  'nih.gov', // Q390551 National Institutes of Health (NLM: PubMed, DailyMed, Bookshelf; the institutes)
  'medlineplus.gov', // Q557919 MedlinePlus (National Library of Medicine)
  'cdc.gov', // Q583725 Centers for Disease Control and Prevention
  'fda.gov', // Q204711 Food and Drug Administration
  'cancer.gov', // Q664846 National Cancer Institute
  'clinicaltrials.gov', // Q5133746 ClinicalTrials.gov (NLM)
  'health.gov', // Q30280995 Office of Disease Prevention and Health Promotion
  'ahrq.gov', // Q4692008 Agency for Healthcare Research and Quality
  'samhsa.gov', // Q7632057 Substance Abuse and Mental Health Services Administration
  'hiv.gov', // HHS HIV.gov (.gov registry; site title "HIV.gov")
  'womenshealth.gov', // Q17072404 Office on Women's Health
  'vaccines.gov', // Q118330113 Vaccines.gov
  'smokefree.gov', // NCI Smokefree.gov (.gov registry; site title "Smokefree")
  // United Kingdom
  'nhs.uk', // Q16251481 National Health Service (the NHS website and NHS bodies, incl. wales.nhs.uk)
  'nice.org.uk', // Q3425168 National Institute for Health and Care Excellence (incl. BNF, CKS)
  'nhsinform.scot', // Q108838033 NHS inform (NHS Scotland)
  'publichealthscotland.scot', // Q89284077 Public Health Scotland
  'sign.ac.uk', // Q30273632 Scottish Intercollegiate Guidelines Network
  // Ireland
  'hse.ie', // Q5690681 Health Service Executive
  'hpra.ie', // Q1483858 Health Products Regulatory Authority
  'hiqa.ie', // Q5690568 Health Information and Quality Authority
  // Canada (canada.ca is the whole federal government, so only the health sections)
  'canada.ca/en/health-canada', // Health Canada (page breadcrumb, checked 2026-10-31)
  'canada.ca/en/public-health', // Public Health Agency of Canada (page "About this site")
  'canada.ca/fr/sante-canada', // Santé Canada
  'canada.ca/fr/sante-publique', // Agence de la santé publique du Canada
  'health-products.canada.ca', // Health Canada drug and health product databases
  'healthlinkbc.ca', // HealthLink BC (footer: "Province of British Columbia")
  // Australia and New Zealand
  'health.gov.au', // Q113588161 Department of Health, Disability and Ageing
  'healthdirect.gov.au', // Q19931441 Healthdirect Australia
  'tga.gov.au', // Q4056087 Therapeutic Goods Administration
  'nhmrc.gov.au', // Q6973022 National Health and Medical Research Council
  'betterhealth.vic.gov.au', // Better Health Channel (footer: Victoria Department of Health)
  'health.govt.nz', // Q16933991 Ministry of Health (New Zealand)
  'healthnz.govt.nz', // Health New Zealand | Te Whatu Ora (site title)
  'info.health.nz', // Health New Zealand health information (redirects to healthnz.govt.nz)
  'medsafe.govt.nz', // Q6807295 Medsafe
  // Germany, Austria, Switzerland
  'bundesgesundheitsministerium.de', // Q491566 Federal Ministry of Health
  'rki.de', // Q679041 Robert Koch Institute
  'gesund.bund.de', // Q105543934 gesund.bund.de (federal health portal)
  'bfarm.de', // Q1006215 Federal Institute for Drugs and Medical Devices
  'pei.de', // Q1476836 Paul Ehrlich Institute
  'iqwig.de', // Q737480 Institute for Quality and Efficiency in Health Care
  'gesundheitsinformation.de', // Q58880045 gesundheitsinformation.de (IQWiG)
  'gesundheit.gv.at', // Q105275824 Austrian public health portal
  'bag.admin.ch', // Q1005448 Federal Office of Public Health
  'swissmedic.ch', // Q681332 Swissmedic
  // France, Belgium, Netherlands
  'sante.gouv.fr', // Q3315346 Ministry of Health
  'sante.fr', // Santé.fr, the public health portal (incl. ansm.sante.fr and the regional ars.sante.fr)
  'has-sante.fr', // Q3128526 Haute Autorité de santé
  'santepubliquefrance.fr', // Q24933114 Santé publique France
  'ameli.fr', // Q2868312 Assurance Maladie
  'health.belgium.be', // Q746439 FPS Public Health
  'sciensano.be', // Q55508919 Sciensano
  'famhp.be', // Q2682107 Federal Agency for Medicines and Health Products
  'rivm.nl', // Q1055186 National Institute for Public Health and the Environment
  'cbg-meb.nl', // Q1989781 Medicines Evaluation Board
  // Nordic countries
  'folkhalsomyndigheten.se', // Q17518896 Public Health Agency of Sweden
  '1177.se', // Q10397075 1177 (Swedish regions' health service)
  'lakemedelsverket.se', // Q1879124 Swedish Medical Products Agency
  'helsenorge.no', // Q19374100 helsenorge.no
  'fhi.no', // Q7061149 Norwegian Institute of Public Health
  'helsedirektoratet.no', // Q11974929 Norwegian Directorate of Health
  'sst.dk', // Q4583472 Danish Health Authority
  'sundhed.dk', // Q12337699 sundhed.dk
  'ssi.dk', // Q3378353 Statens Serum Institut
  'thl.fi', // Q4354957 Finnish Institute for Health and Welfare
  // Southern Europe
  'sanidad.gob.es', // Q3113883 Ministry of Health (Spain)
  'aemps.gob.es', // Q8191326 Spanish Agency of Medicines and Medical Devices
  'salute.gov.it', // Q745634 Ministry of Health (Italy)
  'iss.it', // Q3803682 Istituto Superiore di Sanità
  'aifa.gov.it', // Q3606475 Italian Medicines Agency
  'dgs.pt', // Q10266748 Directorate-General of Health (Portugal)
  'infarmed.pt', // Q10302096 INFARMED
  // East and South Asia
  'mhlw.go.jp', // Q1191238 Ministry of Health, Labour and Welfare
  'jihs.go.jp', // Q133798544 Japan Institute for Health Security
  'pmda.go.jp', // Q932661 Pharmaceuticals and Medical Devices Agency
  'kdca.go.kr', // Q126199836 Korea Disease Control and Prevention Agency
  'mohw.go.kr', // Q482921 Ministry of Health and Welfare (Korea)
  'mfds.go.kr', // Q482905 Ministry of Food and Drug Safety
  'nhc.gov.cn', // Q50839200 National Health Commission of the PRC
  'chinacdc.cn', // Q5100405 Chinese Center for Disease Control and Prevention
  'chp.gov.hk', // Q2968915 Centre for Health Protection (Hong Kong)
  'dh.gov.hk', // Q2303626 Department of Health (Hong Kong)
  'moh.gov.sg', // Q4383964 Ministry of Health (Singapore)
  'healthhub.sg', // HealthHub (footer: Ministry of Health Singapore)
  'hsa.gov.sg', // Q5690654 Health Sciences Authority
  'mohfw.gov.in', // Q3525265 Ministry of Health and Family Welfare
  'icmr.gov.in', // Q291019 Indian Council of Medical Research
  // Africa and Latin America
  'health.gov.za', // Q4294368 National Department of Health (South Africa)
  'nicd.ac.za', // Q55641219 National Institute for Communicable Diseases
  'sahpra.org.za', // South African Health Products Regulatory Authority (site title)
  'gov.br/saude', // Ministério da Saúde (gov.br is the whole federal government)
  'gov.br/anvisa', // Anvisa
  'gob.mx/salud', // Secretaría de Salud (gob.mx is the whole federal government)
  'argentina.gob.ar/salud', // Ministerio de Salud (argentina.gob.ar is the whole government)
  // Clinical reference: academic medical centres, manuals and evidence reviews
  'mayoclinic.org', // Q1130172 Mayo Clinic
  'clevelandclinic.org', // Q4117596 Cleveland Clinic (health library on my.clevelandclinic.org)
  'hopkinsmedicine.org', // Q50363516 Johns Hopkins Medicine
  'msdmanuals.com', // Q7751055 MSD Manuals
  'merckmanuals.com', // Q7751055 Merck Manuals (the US name of the same work)
  'cochrane.org', // Q1105202 Cochrane
  'cochranelibrary.com', // Q1105187 Cochrane Library
]
