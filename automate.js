// automate.js
// Deps: npm i selenium-webdriver chromedriver
// Run : node automate.js
//
// emails.txt lines: "<email> <password>"
// Output: keys.txt lines: "<API_KEY> <EMAIL> <PROJECT_ID>"

const fs = require('fs');
const path = require('path');
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

/* ====== CONFIG ====== */
const EMAILS_FILE = path.join(__dirname, 'emails.txt');
const OUTPUT_FILE = path.join(__dirname, 'keys.txt');

// Your organization shown in the picker
const ORG_RESOURCE_NAME = 'organizations/542207717958';
const ORG_DISPLAY_NAME = 'cats-cocoon.org';

const CONCURRENCY = 1;
const PROJECTS_PER_USER = 5;
const PROJECT_TAIL = '542207717958';

const TIME = {
  step: 40000,
  login: 150000,
  navSettle: 2000,
  short: 800,
  clickCooldown: 600,
};

const ERR = {
  STALE: /stale element/i,
  NOT_INTERACT: /not interactable/i,
};

const S = (ms) => new Promise(r => setTimeout(r, ms));

// put near other helpers
async function waitOneVisible(driver, locators, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const loc of locators) {
      const els = await driver.findElements(loc);
      if (!els.length) continue;
      const el = els[0];
      try {
        await driver.wait(until.elementIsVisible(el), 2000);
        return el; // visible!
      } catch { }
    }
    await S(250);
  }
  throw new Error('Timed out waiting for one of the target elements to be visible');
}

// See if the Auth UI looks initialized (no "Get started", has Users/Providers UI)
async function isAuthInitializedUI(driver) {
  const probes = [
    By.xpath("//button[contains(., 'Add user') or contains(., 'Add User')]"),
    By.xpath("//a[contains(@href,'/authentication/providers') or contains(.,'Sign-in method')]"),
    By.xpath("//*[self::h1 or self::h2][contains(.,'Users')]"),
    By.css('[data-test-id="auth-users-table"]'),
  ];
  for (const loc of probes) {
    const els = await driver.findElements(loc);
    if (els.length) return true;
  }
  return false;
}

// Wait for any one of the locators to become visible (reusable)
async function waitOneVisible(driver, locators, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const loc of locators) {
      const els = await driver.findElements(loc);
      if (!els.length) continue;
      const el = els[0];
      try { await driver.wait(until.elementIsVisible(el), 1500); return el; } catch { }
    }
    await S(250);
  }
  throw new Error('Timed out waiting for target element to be visible');
}


// Wait until a specific input becomes enabled (not disabled/readOnly)
async function waitInputEnabled(driver, el, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const enabled = await driver.executeScript(
        "return !arguments[0].disabled && !arguments[0].readOnly;", el
      );
      if (enabled) return true;
    } catch { }
    await S(150);
  }
  throw new Error('Project name input stayed disabled too long');
}

// Find the Project name input (works for both fresh + normal wizards)
async function findProjectNameInput(driver) {
  const locators = [
    By.css('input[aria-label="Project name"]'),
    By.css('input[name="projectName"]'),
    By.css('input.fire-input-field[placeholder="Project name"]'),
    By.css('input.fire-input-field'),
    By.xpath("//input[@type='text' and (contains(@placeholder,'Project') or contains(@aria-label,'Project'))]"),
  ];
  // waitAnyVisible is your existing helper; if you don't have it, replace with waitVisible on the first locator
  return await waitAnyVisible(driver, locators, 30000);
}

// Type the projectId robustly (slow keys + JS fallback), then verify
async function typeProjectName(driver, projectId) {
  const el = await findProjectNameInput(driver);
  await waitInputEnabled(driver, el, 15000);

  // try normal typing first (slower to avoid races)
  try { await driver.executeScript("arguments[0].focus();", el); } catch { }
  try { await el.clear(); } catch { }
  for (const ch of projectId) {
    await el.sendKeys(ch);
    await S(15); // tiny delay to let Angular form control update
  }

  // verify value; fallback to JS set + events if mismatch
  let val = await driver.executeScript("return arguments[0].value || '';", el);
  if (val !== projectId) {
    await driver.executeScript(`
      const el = arguments[0], v = arguments[1];
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    `, el, projectId);
    await S(150);
    val = await driver.executeScript("return arguments[0].value || '';", el);
  }

  // blur to trigger validators
  try { await el.sendKeys('\uE004'); /* TAB */ } catch { }
  await S(200);

  if (val !== projectId) {
    throw new Error(`Project name did not stick (got "${val}")`);
  }
  console.log(`[${projectId}] Project name typed & verified`);
}


async function handleGoogleSpeedbumpIfPresent(driver) {
  // This page lives at accounts.google.com/speedbump/...
  // The confirm control is language-agnostic via name="confirm"
  const confirmLocators = [
    By.css('input#confirm[name="confirm"]'),
    By.css('input[type="submit"][name="confirm"]'),
    By.xpath("//input[@name='confirm' and (@type='submit' or @id='confirm')]"),
    By.xpath("//button[@id='confirm' or @name='confirm']"), // fallback if rendered as <button>
  ];

  // quick scan for up to ~10s
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { await driver.switchTo().defaultContent(); } catch { }
    const url = await driver.getCurrentUrl();
    const onSpeedbump = /accounts\.google\.com\/speedbump/i.test(url);

    for (const loc of confirmLocators) {
      const els = await driver.findElements(loc);
      if (els.length) {
        console.log(`[login] Speedbump detected — clicking confirm`);
        await safeClick(driver, loc, 10000);
        await waitPageStable(driver, 800);
        return true;
      }
    }

    if (!onSpeedbump) return false; // not on speedbump and no button found
    await S(300);
  }
  return false;
}

async function checkAnalyticsTermsCheckbox(driver, projectId) {
  // Primary: any REQUIRED GA checkbox on this step
  const requiredBoxes = await driver.findElements(
    By.css('input.mdc-checkbox__native-control[type="checkbox"][required]')
  );

  if (requiredBoxes.length) {
    for (const box of requiredBoxes) {
      const checked = await driver.executeScript('return arguments[0].checked === true;', box);
      if (!checked) {
        await driver.executeScript('arguments[0].click();', box);
        await S(200);
      }
    }
    console.log(`[${projectId}] Checked Google Analytics terms checkbox`);
    return;
  }

  // Fallback: a checkbox immediately before/near GA text (UI variants)
  const byLabel = By.xpath(
    "//input[@type='checkbox' and contains(@class,'mdc-checkbox__native-control')][not(@checked)]" +
    "[ancestor::*[contains(.,'Google Analytics') or contains(.,'Analytics terms')]]"
  );
  const els = await driver.findElements(byLabel);
  if (els.length) {
    await driver.executeScript('arguments[0].click();', els[0]);
    await S(200);
    console.log(`[${projectId}] Checked GA terms via label proximity`);
  } else {
    console.log(`[${projectId}] GA terms checkbox not found (maybe already accepted)`);
  }
}


async function ensureAuthInitialized(driver, projectId) {
  const usersURL = `https://console.firebase.google.com/project/${projectId}/authentication/users`;
  const providersURL = `https://console.firebase.google.com/project/${projectId}/authentication/providers`;
  const getStartedBtn = By.xpath("//button[contains(., 'Get started') or contains(., 'Get Started')]");
  const initHints = [
    By.xpath("//button[contains(., 'Add user') or contains(., 'Add User')]"),
    By.xpath("//a[contains(@href,'/authentication/providers') or contains(.,'Sign-in method')]"),
    By.xpath("//*[self::h1 or self::h2][contains(.,'Users')]"),
  ];

  for (let pass = 1; pass <= 2; pass++) {
    console.log(`[${projectId}] Auth init check: pass ${pass}/2`);
    await goto(driver, usersURL);
    await waitPageStable(driver, 800);

    // Wait until either "Get started" OR initialized hints appear
    try {
      await waitOneVisible(driver, [getStartedBtn, ...initHints], 90000);
    } catch {
      // Slow console → refresh once
      await driver.navigate().refresh();
      await waitPageStable(driver, 800);
      await waitOneVisible(driver, [getStartedBtn, ...initHints], 60000);
    }

    const gs = await driver.findElements(getStartedBtn);
    if (gs.length) {
      console.log(`[${projectId}] Auth: 'Get started' is visible → clicking…`);
      await safeClick(driver, getStartedBtn, 30000);
      await waitPageStable(driver, 1000);

      // Wait until button disappears and hints show
      await driver.wait(async () => {
        const stillThere = (await driver.findElements(getStartedBtn)).length > 0;
        if (stillThere) return false;
        return await isAuthInitializedUI(driver);
      }, 60000).catch(() => { });
    } else {
      console.log(`[${projectId}] Auth: UI already looks initialized`);
    }

    // Extra stabilization: bounce to Providers then back to Users
    await goto(driver, providersURL);
    await waitPageStable(driver, 600);
    await goto(driver, usersURL);
    await waitPageStable(driver, 600);

    if (await isAuthInitializedUI(driver)) {
      console.log(`[${projectId}] Auth initialized ✅`);
      return true;
    }
    console.warn(`[${projectId}] Auth still not clearly initialized after pass ${pass}`);
  }

  throw new Error('Auth still not initialized after 2 passes');
}



async function ensureProjectSettingsContext(driver, projectId) {
  // We rely on the "Project ID" field value to match our projectId
  await driver.wait(async () => {
    const text = await driver.executeScript(() => {
      const row = [...document.querySelectorAll('div, td, span')].find(
        el => /Project ID/i.test(el.textContent || '')
      );
      if (!row) return '';
      // grab the next sibling/text that contains the value
      const container = row.closest('tr, .mat-mdc-table, .mdc-card, .c5e-project-settings-item') || document.body;
      const matches = [...container.querySelectorAll('*')].map(e => e.textContent?.trim()).filter(Boolean);
      // find the first thing that looks like a project id
      const val = matches.find(t => /^[a-z0-9-]{6,}$/.test(t));
      return val || '';
    });
    return text && text.toLowerCase() === projectId.toLowerCase();
  }, 5000).catch(() => { });
}

async function ensureProjectSettingsContext(driver, projectId) {
  // Confirm the settings page belongs to this projectId
  await driver.wait(async () => {
    const val = await driver.executeScript(() => {
      const row = [...document.querySelectorAll('div, td, span')]
        .find(el => /Project ID/i.test(el.textContent || ''));
      if (!row) return '';
      const container = row.closest('tr, .c5e-project-settings-item, .mdc-card, .mat-mdc-card') || document.body;
      const texts = [...container.querySelectorAll('*')].map(e => (e.textContent || '').trim()).filter(Boolean);
      const id = texts.find(t => /^[a-z0-9-]{6,}$/.test(t));
      return id || '';
    });
    return val && val.toLowerCase() === projectId.toLowerCase();
  }, 5000).catch(() => { });
}

async function fetchApiKeyFromSettings(driver, projectId) {
  const settingsURL = `https://console.firebase.google.com/project/${projectId}/settings/general`;
  const apiSection = By.css('div[data-test-id="web-api-key-section"]');

  // Do two rounds: if round 1 fails, re-run ensureAuthInitialized and try again
  for (let round = 1; round <= 2; round++) {
    console.log(`[${projectId}] Fetch API key: round ${round}/2`);
    await goto(driver, settingsURL);
    await ensureProjectSettingsContext(driver, projectId);

    const start = Date.now();
    while (Date.now() - start < 25000) { // 25s budget per round
      try {
        await waitVisible(driver, apiSection, 5000);
        const key = await driver.executeScript(() => {
          const sec = document.querySelector('div[data-test-id="web-api-key-section"]');
          const span = sec?.querySelector('span');
          const val = (span?.innerText || span?.textContent || '').trim();
          return val || '';
        });
        if (/^AIza[0-9A-Za-z_\-]{10,}$/.test(key)) {
          return key;
        }
      } catch { /* ignore, try again */ }

      // If page explicitly says "No Web API Key", don't waste time — break to retry
      const noKey = await driver.executeScript(() => {
        const sec = document.querySelector('div[data-test-id="web-api-key-section"]');
        return !!sec && /no web api key/i.test(sec.textContent || '');
      });
      if (noKey) break;

      await S(2500);
      await driver.navigate().refresh();
      await waitPageStable(driver, 600);
      await ensureProjectSettingsContext(driver, projectId);
    }

    // Round failed → re-initialize Auth before round 2
    if (round === 1) {
      console.log(`[${projectId}] API key not visible yet → re-checking Auth…`);
      try { await ensureAuthInitialized(driver, projectId); } catch (e) { console.warn(`[${projectId}] Auth recheck warning: ${e.message}`); }
      await S(1200);
    }
  }

  throw new Error('Web API Key not found in Settings → General after 2 rounds');
}


async function finalizeWebAppWizard(driver, projectId) {
  // After "Register app", there are 1–2 screens with "Next"/"Continue to console"
  const nextLike = By.xpath("//button[contains(.,'Next') or contains(.,'Continue')]");
  for (let i = 0; i < 3; i++) {
    const btns = await driver.findElements(nextLike);
    if (!btns.length) break;
    try { await safeClick(driver, nextLike, 8000); } catch { }
    await waitPageStable(driver, 600);
  }
  // tiny pause so backend can provision the web API key
  await S(1200);
}


// put near other helpers (S, waitPageStable, etc.)
async function waitAnyVisible(driver, locators, timeout = TIME.step) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const loc of locators) {
      const els = await driver.findElements(loc);
      if (els.length) {
        const el = els[0];
        try {
          await driver.wait(until.elementIsVisible(el), 1500);
          // enabled can flip after ~1s — tolerate brief disabled state
          try { await driver.wait(until.elementIsEnabled(el), 1500); } catch { }
          return el;
        } catch { }
      }
    }
    await S(250);
  }
  throw new Error('Timed out waiting for one of the locators to become visible');
}


/* ====== Debug ====== */
async function dumpDebug(driver, tag = 'debug') {
  try {
    const ts = Date.now();
    const png = await driver.takeScreenshot();
    // const html = await driver.getPageSource();
    fs.writeFileSync(path.join(__dirname, `logs/dbg-${tag}-${ts}.png`), Buffer.from(png, 'base64'));
    // fs.writeFileSync(path.join(__dirname, `dbg-${tag}-${ts}.html`), html, 'utf8');
    console.log(`Saved dbg-${tag}-${ts}.png`);
  } catch { }
}

/* ====== Users file ====== */
function parseUsers() {
  // if (!fs.existsSync(EMAILS_FILE)) {
  //   console.error(`Missing ${EMAILS_FILE}`);
  //   process.exit(1);
  // }
  // return fs.readFileSync(EMAILS_FILE, 'utf8')
  //   .split('\n').map(s => s.trim()).filter(Boolean)
  //   .map(l => {
  //     const [email, password] = l.split(/\s+/);
  //     const m = email?.match(/u(\d{5})@/i);
  //     if (!m) return null;
  //     const num = m[1];
  //     return { email, password, userBase: `u${num}` };
  //   })
  //   .filter(Boolean);
  const users = [];
  for (let i = 1; i <= 600; i++) {
    const email = `user${i}${ORG_DISPLAY_NAME}`;
    const password = `Password123!`;
    users.push({ email, password });
  }
  return users;
}

/* ====== Driver ====== */
async function buildDriver() {
  const options = new chrome.Options();
  options.addArguments(
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--start-maximized'
  );
  return new Builder().forBrowser('chrome').setChromeOptions(options).build();
}


/* ====== Waiters & Safe Actions (locator-based) ====== */
async function waitVisible(driver, locator, timeout = TIME.step) {
  const el = await driver.wait(until.elementLocated(locator), timeout);
  await driver.wait(until.elementIsVisible(el), timeout);
  await driver.wait(until.elementIsEnabled(el), timeout);
  return el;
}

async function safeType(driver, locator, text, timeout = TIME.step, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const el = await waitVisible(driver, locator, timeout);
      await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", el);
      try { await el.clear(); } catch { }
      await el.sendKeys(text);
      return;
    } catch (e) {
      if (ERR.STALE.test(String(e)) && i < retries - 1) { await S(200); continue; }
      if (ERR.NOT_INTERACT.test(String(e)) && i < retries - 1) {
        try {
          const el2 = await waitVisible(driver, locator, timeout);
          await driver.executeScript("arguments[0].value=''; arguments[0].focus();", el2);
          await el2.sendKeys(text);
          return;
        } catch { }
      }
      throw e;
    }
  }
}

async function safeClick(driver, locator, timeout = TIME.step, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const el = await waitVisible(driver, locator, timeout);
      await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", el);
      await el.click();
      await S(TIME.clickCooldown);
      return;
    } catch (e) {
      if (ERR.STALE.test(String(e)) && i < retries - 1) { await S(250); continue; }
      if (i < retries - 1) {
        try {
          const el2 = await waitVisible(driver, locator, timeout);
          await driver.executeScript("arguments[0].click();", el2);
          await S(TIME.clickCooldown);
          return;
        } catch { }
      }
      throw e;
    }
  }
}

async function waitPageStable(driver, ms = TIME.navSettle) {
  await S(ms);
  try {
    await driver.wait(async () => {
      const ready = await driver.executeScript('return document.readyState');
      return ready === 'complete' || ready === 'interactive';
    }, TIME.step);
  } catch { }
}

/* ====== Small helpers ====== */
async function goto(driver, url) { await driver.get(url); await waitPageStable(driver); }

async function maybeHandleCookieBanner(driver) {
  const locs = [
    By.xpath("//button[.='Accept all' or .='I agree' or contains(.,'Accept all') or contains(.,'I agree')]"),
    By.xpath("//*[contains(@id,'introAgree')][self::button]"),
    By.xpath("//button[contains(.,'Accept')]"),
  ];
  for (const loc of locs) {
    const els = await driver.findElements(loc);
    if (els.length) { try { await safeClick(driver, loc, 5000); break; } catch { } }
  }
}

async function maybeSwitchToLoginIframe(driver) {
  const frames = await driver.findElements(By.css('iframe'));
  for (const f of frames) {
    const title = (await f.getAttribute('title')) || '';
    const name = (await f.getAttribute('name')) || '';
    if (/sign\s?in|signin|login/i.test(title) || /sign/i.test(name)) {
      await driver.switchTo().frame(f);
      return true;
    }
  }
  return false;
}

// Attempt to change Firebase console language to English (United States)
async function changeFirebaseConsoleLanguage(driver) {
  try {
    // mat-select with id=language-selector
    const selector = By.css('mat-select#language-selector, mat-select[id="language-selector"]');
    const optionEnglishXpath = By.xpath("//mat-option[.//span[contains(normalize-space(.), 'English (United States)') or contains(normalize-space(.), 'anglais (États-Unis)')]]");
    const optionEnglishAlt = By.xpath("//mat-option[.//span[contains(normalize-space(.), 'anglais (États-Unis)') or contains(normalize-space(.), 'English (United States)')]]");

    // Try to find and click the language selector (short timeout, safe no-op if not present)
    const selEls = await driver.findElements(selector);
    if (!selEls.length) {
      console.log('Language selector not present on this page (skipping language switch)');
      return;
    }

    console.log('Opening language selector...');
    await safeClick(driver, selector, 8000);
    await waitPageStable(driver, 400);

    // Wait for the option to appear in the overlay and click it
    try {
      await waitAnyVisible(driver, [optionEnglishXpath, optionEnglishAlt], 8000);
      try { await safeClick(driver, optionEnglishXpath, 8000); }
      catch (e) { await safeClick(driver, optionEnglishAlt, 8000); }
      await waitPageStable(driver, 800);
      console.log('Requested console language change to English (United States)');
    } catch (e) {
      console.warn('English option not found in language dropdown: ' + e.message);
    }
  } catch (e) {
    console.warn('changeFirebaseConsoleLanguage failed: ' + e.message);
  }
}

async function readWizardTitle(driver) {
  try {
    return await driver.executeScript(function () {
      const sels = [
        '[role="dialog"] h1', '[role="dialog"] h2',
        'mwc-dialog h1', 'mwc-dialog h2', 'h1', 'h2'
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
      }
      return '';
    });
  } catch { return ''; }
}

async function isAnalyticsPage(driver) {
  try {
    const title = await readWizardTitle(driver);
    if (/configure google analytics/i.test(title)) return true;
  } catch { }
  const els = await driver.findElements(By.css('#createProjectAnalyticsAccountInput'));
  return els.length > 0;
}

async function selectAnalyticsAccount(driver, projectId) {
  console.log(`[${projectId}] Analytics: opening account dropdown`);
  await safeClick(driver, By.css('#createProjectAnalyticsAccountInput'), 20000);
  const option = By.xpath(
    "//button[.//span[normalize-space(.)='Default Account for Firebase']]|" +
    "//span[normalize-space(.)='Default Account for Firebase']/ancestor::button[1]"
  );
  await safeClick(driver, option, 15000);
  await waitPageStable(driver, 400);
  console.log(`[${projectId}] Analytics: selected "Default Account for Firebase"`);
}

/* ====== Auth flow ====== */
async function loginGoogle(driver, email, password) {
  await goto(driver, 'https://accounts.google.com/signin/v2/identifier');
  await maybeHandleCookieBanner(driver);

  await maybeSwitchToLoginIframe(driver);
  await safeType(driver, By.css('#identifierId, input[type="email"]'), email);
  await safeClick(driver, By.css('#identifierNext button, #identifierNext'));

  try { await driver.switchTo().defaultContent(); } catch { }
  await S(TIME.short);

  await maybeSwitchToLoginIframe(driver);
  await safeType(driver, By.css('input[type="password"]'), password);
  await safeClick(driver, By.css('#passwordNext button, #passwordNext'));

  // ✅ Wait until we either land on console/myaccount OR hit the speedbump
  await driver.wait(async () => {
    const url = await driver.getCurrentUrl();
    return /myaccount\.google\.com|console\.google\.com|firebase\.google\.com|accounts\.google\.com\/speedbump/i.test(url);
  }, TIME.login);

  // ✅ If speedbump showed up, click the confirm and then wait for a real redirect
  let url = await driver.getCurrentUrl();
  if (/accounts\.google\.com\/speedbump/i.test(url)) {
    await handleGoogleSpeedbumpIfPresent(driver);
    await driver.wait(async () => {
      const u = await driver.getCurrentUrl();
      return /myaccount\.google\.com|console\.google\.com|firebase\.google\.com/.test(u);
    }, TIME.login);
  }

  await goto(driver, 'https://console.firebase.google.com/');
}


// Open the create-project wizard for both dashboards (fresh & normal)
async function openCreateProjectWizard(driver) {
  await goto(driver, 'https://console.firebase.google.com/');
  await waitPageStable(driver, 800);

  const candidates = [
    By.css('fire-action-card[data-test-id="create-project-card"]'),
    By.xpath("//button[.//span[contains(normalize-space(.),'Create a Firebase project')]]"),
    By.xpath("//button[contains(., 'Create a project') or contains(., 'Add project') or contains(., 'Create another project')]"),
    // fresh account "welcome" card:
    By.css('welcome-create-project-card[data-test-id="create-project-card"] fire-card-body[role="button"]'),
    By.xpath("//welcome-create-project-card//*[@role='button' and contains(@aria-label,'Get started with a Firebase project')]"),
  ];

  for (const loc of candidates) {
    const els = await driver.findElements(loc);
    if (!els.length) continue;
    try { await safeClick(driver, loc, 20000); await waitPageStable(driver, 800); break; } catch { }
  }

  await driver.wait(
    until.elementLocated(By.css('input[aria-label="Project name"], input[name="projectName"], input[type="text"]')),
    20000
  );
}

// Fresh-account only (safe to call always): pick the org/folder
async function selectParentResourceIfNeeded(driver, projectId) {
  // Try several locators to find the "Select parent resource" control. The button
  // may render with extra markup/classes or slightly different text in different UIs.
  const locators = [
    By.xpath("//button[.//span[normalize-space(.)='Select parent resource'] or contains(., 'Select parent resource') or contains(., 'Select organization')]"),
    By.css('button.selector-chip'),
    By.xpath("//div[contains(@class,'selector-chip-content')]//span[contains(normalize-space(.),'Select parent resource')]/ancestor::button[1]"),
    By.xpath("//button[.//span[contains(normalize-space(.),'Select parent')]]")
  ];

  let found = false;
  let switchedToFrame = false;
  for (const loc of locators) {
    const els = await driver.findElements(loc);
    if (!els.length) continue;
    // Prefer clicking only elements whose visible text indicates the selector
    for (const el of els) {
      try {
        const txt = (await el.getText() || '').replace(/\u00A0/g, ' ').trim();
        if (!/select parent resource|select parent|select organization/i.test(txt)) {
          console.log(`[${projectId}] Skipping element for locator ${loc.toString()} (text: "${txt}")`);
          continue;
        }
        console.log(`[${projectId}] Opening parent resource selector (locator: ${loc.toString()}, text: "${txt}")`);
        try {
          await driver.executeScript('arguments[0].scrollIntoView({block:"center"}); arguments[0].click();', el);
        } catch {
          // fallback to locator-based safeClick
          await safeClick(driver, loc, 20000);
        }
        found = true;
        break;
      } catch (e) {
        console.warn(`[${projectId}] Element click attempt failed: ${e.message}`);
      }
    }
    if (found) break;
  }

  // Fallback: scan all buttons and match visible text heuristically
  if (!found) {
    // Try inside iframes: some UIs render the selector in an iframe
    const frames = await driver.findElements(By.css('iframe'));
    for (const f of frames) {
      try {
        await driver.switchTo().frame(f);
        switchedToFrame = true;
        for (const loc of locators) {
          const els = await driver.findElements(loc);
          if (!els.length) continue;
          for (const el of els) {
            try {
              const txt = (await el.getText() || '').replace(/\u00A0/g, ' ').trim();
              if (!/select parent resource|select parent|select organization/i.test(txt)) {
                console.log(`[${projectId}] (iframe) Skipping element for locator ${loc.toString()} (text: "${txt}")`);
                continue;
              }
              console.log(`[${projectId}] (iframe) Opening parent resource selector (locator: ${loc.toString()}, text: "${txt}")`);
              await driver.executeScript('arguments[0].scrollIntoView({block:"center"}); arguments[0].click();', el);
              found = true;
              break;
            } catch (e) { console.warn(`[${projectId}] (iframe) element click failed: ${e.message}`); }
          }
          if (found) break;
        }
        if (found) break;
      } catch (e) { /* ignore */ }
      finally {
        // switch back to top-level so next iframe iteration starts clean
        try { await driver.switchTo().defaultContent(); switchedToFrame = false; } catch { }
      }
    }

    // If still not found, fallback to scanning top-level buttons by text
    const allBtns = await driver.findElements(By.css('button'));
    for (const b of allBtns) {
      try {
        const txt = (await b.getText() || '').replace(/\u00A0/g, ' ').trim();
        if (/select parent resource|select parent|select organization/i.test(txt)) {
          console.log(`[${projectId}] Opening parent resource selector (found by text: "${txt}")`);
          try {
            await driver.executeScript('arguments[0].scrollIntoView({block:"center"}); arguments[0].click();', b);
            found = true;
            break;
          } catch (e) { console.warn('click-by-element failed: ' + e.message); }
        }
      } catch { }
    }
  }

  if (!found) {
    console.log(`[${projectId}] Parent resource selector not shown (skipping)`);
    return;
  }

  // Ensure we're back in the top-level context for subsequent DOM queries
  try { await driver.switchTo().defaultContent(); } catch { }
  await waitPageStable(driver, 500);

  // Wait briefly for the parent-resource dialog/tree to appear (org nodes)
  const orgNodeLocs = [
    By.css(`cdk-tree-node[data-resource-name="${ORG_RESOURCE_NAME}"]`),
    By.xpath(`//cdk-tree-node[@data-resource-name='${ORG_RESOURCE_NAME}']`),
    By.xpath(`//cdk-tree-node[.//span[normalize-space(.)='${ORG_DISPLAY_NAME}']]`)
  ];
  const end = Date.now() + 8000;
  let dialogFound = false;
  while (Date.now() < end) {
    for (const loc of orgNodeLocs) {
      const els = await driver.findElements(loc);
      if (els.length) { dialogFound = true; break; }
    }
    if (dialogFound) break;
    await S(300);
  }
  if (!dialogFound) console.warn(`[${projectId}] Parent resource dialog did not appear after clicking selector`);

  // Reuse orgNodeLocs declared above for selecting the organization node

  let clicked = false;
  for (const loc of orgNodeLocs) {
    const els = await driver.findElements(loc);
    if (!els.length) continue;
    try {
      await driver.executeScript("arguments[0].scrollIntoView({block:'center'}); arguments[0].click();", els[0]);
      clicked = true;
      break;
    } catch { }
  }
  if (!clicked) throw new Error('Could not select organization in parent resource dialog');

  // Some UIs have a "Select" / "Done" button; try it if present
  const confirm = By.xpath("//button[normalize-space(.)='Select' or contains(.,'Done')]");
  const confEls = await driver.findElements(confirm);
  if (confEls.length) {
    try { await safeClick(driver, confirm, 10000); } catch { }
  }

  await waitPageStable(driver, 700);
  console.log(`[${projectId}] Parent resource selected (${ORG_DISPLAY_NAME})`);
}

// Fresh-account only (safe to call always): accept terms if shown
async function acceptFirebaseTermsIfPresent(driver, projectId) {
  // Look for any unchecked MDC checkbox in the wizard
  const boxes = await driver.findElements(By.css('input.mdc-checkbox__native-control[type="checkbox"]'));
  if (!boxes.length) {
    console.log(`[${projectId}] Terms checkbox not shown (skipping)`);
    return;
  }

  // Click the first unchecked one
  for (const box of boxes) {
    const checked = await driver.executeScript('return !!arguments[0].checked;', box);
    if (!checked) {
      try {
        await driver.executeScript('arguments[0].click();', box);
        console.log(`[${projectId}] Accepted Firebase terms`);
        break;
      } catch { }
    }
  }
  await waitPageStable(driver, 300);
}

/* ====== Project creation (with GA step) ====== */
async function createFirebaseProject(driver, projectId) {
  await openCreateProjectWizard(driver);
  await typeProjectName(driver, projectId);  // ⬅️ use the robust typer

  // NEW: fresh-account extras (safe no-ops if not present)
  await selectParentResourceIfNeeded(driver, projectId);
  await acceptFirebaseTermsIfPresent(driver, projectId);

  // Your existing 3-step flow (with analytics handling & logs)
  for (let step = 1; step <= 3; step++) {
    const title = await readWizardTitle(driver);
    console.log(`[${projectId}] Step ${step}/3: ${title || 'Unknown step'}`);

    if (await isAnalyticsPage(driver)) {
      try { await selectAnalyticsAccount(driver, projectId); } catch (e) { console.warn(`[${projectId}] Analytics select failed: ${e.message}`); }

      // ✅ Tick the Google Analytics terms checkbox (first-time only)
      await checkAnalyticsTermsCheckbox(driver, projectId);

      await driver.wait(async () => {
        const btns = await driver.findElements(By.xpath("//button[contains(., 'Create project')]"));
        if (!btns.length) return false;
        return !(await btns[0].getAttribute('disabled'));
      }, 20000);
      console.log(`[${projectId}] Create project button enabled`);
    }

    const nextBtn = By.xpath("//button[contains(., 'Continue') or contains(., 'Next') or contains(., 'Create project') or contains(., 'Accept')]");
    try {
      await safeClick(driver, nextBtn, 2000);
      console.log(`[${projectId}] Step ${step}: clicked Next/Continue/Create`);
    } catch (e) {
      // If it still failed (e.g., checkbox gate), tick again and retry once
      await checkAnalyticsTermsCheckbox(driver, projectId);
      await safeClick(driver, nextBtn, 5000);
    }
    await waitPageStable(driver);
  }

  // Final Continue after creation
  try {
    const contBtn = By.xpath("//button[contains(., 'Continue')]");
    const conts = await driver.wait(until.elementsLocated(contBtn), 90000);
    if (conts.length) {
      try { await conts[0].click(); } catch { await driver.executeScript("arguments[0].click();", conts[0]); }
    }
  } catch { console.warn('Project ready modal not found—continuing.'); }

  await waitPageStable(driver);
}


/* ====== Create Web App & capture keys ====== */
async function openWebAppWizard(driver, projectId) {
  // Settings → General (Your apps area)
  await goto(driver, `https://console.firebase.google.com/project/${projectId}/settings/general`);
  await waitPageStable(driver, 800);

  // Primary button you provided
  const webAppBtn = By.css('button[data-test-id="create-web-app"]');

  try {
    await safeClick(driver, webAppBtn, 20000);
    await waitPageStable(driver, 400);
  } catch (e) {
    console.warn(`[${projectId}] direct web-app button not clickable, trying fallbacks…`);

    // Fallbacks if UI changes
    const addAppBtn = By.xpath("//button[.//span[normalize-space(.)='Add app']]");
    const hasAdd = await driver.findElements(addAppBtn);
    if (hasAdd.length) {
      await safeClick(driver, addAppBtn, 15000);
      await waitPageStable(driver, 400);
      const chooseWeb = By.xpath(
        "//div[@role='dialog']//button[.//span[contains(.,'Web')]]|" +
        "//button[.//span[contains(.,'Web app')]]|" +
        "//button[contains(@aria-label,'Web')]"
      );
      await safeClick(driver, chooseWeb, 15000);
      await waitPageStable(driver, 400);
    } else {
      await goto(driver, `https://console.firebase.google.com/project/${projectId}/overview`);
      const overviewWeb = By.xpath("//button[@data-test-id='create-web-app' or .//span[contains(.,'Web')]]");
      await safeClick(driver, overviewWeb, 15000);
      await waitPageStable(driver, 400);
    }
  }

  // Wait for the nickname input (your exact field + robust fallbacks)
  const nicknameLocators = [
    By.css('input.fire-input-field[placeholder="My web app"]'), // your element
    By.css('input[id^="fbc_"].fire-input-field'),               // dynamic id pattern fbc_*
    By.css('input[placeholder="My web app"]'),
    By.xpath("//input[@placeholder='My web app' or @name='appName' or @aria-label='App nickname']")
  ];
  await waitAnyVisible(driver, nicknameLocators, 20000);
  console.log(`[${projectId}] Web app wizard opened`);
}

async function registerWebApp(driver, projectId) {
  const nicknameLocators = [
    By.css('input.fire-input-field[placeholder="My web app"]'),
    By.css('input[id^="fbc_"].fire-input-field'),
    By.css('input[placeholder="My web app"]'),
    By.xpath("//input[@placeholder='My web app' or @name='appName' or @aria-label='App nickname']")
  ];

  // Wait for it to appear
  const el = await waitAnyVisible(driver, nicknameLocators, 20000);

  // Some consoles attach the input then enable it ~1s later — poll for enabled
  await driver.wait(async () => {
    try { return await driver.executeScript("return !arguments[0].disabled && !arguments[0].readOnly;", el); }
    catch { return false; }
  }, 10000).catch(() => { }); // don’t fail if the property isn’t present

  // Now type projectId into the same locator set (locator-based typing is more robust)
  // Pick the first matching locator again so safeType can re-find it if DOM churns
  const firstLocator = nicknameLocators[0];
  await safeType(driver, firstLocator, projectId);

  // Wait until "Register app" is enabled, then click it
  const regBtn = By.xpath("//button[contains(.,'Register app') or contains(.,'Register App')]");
  await driver.wait(async () => {
    const btns = await driver.findElements(regBtn);
    if (!btns.length) return false;
    const disabled = await btns[0].getAttribute('disabled');
    return !disabled;
  }, 20000);

  await safeClick(driver, regBtn, 20000);
  await waitPageStable(driver, 800);
  console.log(`[${projectId}] Web app registered with nickname = ${projectId}`);
}


async function extractConfigFromPage(driver) {
  // Try to read apiKey & appId from any code/pre element on the page
  const { apiKey, appId } = await driver.executeScript(function () {
    const grabText = () => {
      const parts = [];
      document.querySelectorAll('code, pre, .code, .mat-mdc-card, .mdc-card').forEach(el => {
        const t = el.innerText || el.textContent || '';
        if (t) parts.push(t);
      });
      return parts.join('\n');
    };
    const blob = grabText();
    const apiKeyMatch = blob.match(/apiKey\s*:\s*['"]([^'"]+)['"]/) || blob.match(/"apiKey"\s*:\s*"([^"]+)"/);
    const appIdMatch = blob.match(/appId\s*:\s*['"]([^'"]+)['"]/) || blob.match(/"appId"\s*:\s*"([^"]+)"/);
    return {
      apiKey: apiKeyMatch ? apiKeyMatch[1] : '',
      appId: appIdMatch ? appIdMatch[1] : ''
    };
  });

  return { apiKey, appId };
}

async function createWebAppAndSave(driver, projectId, email) {
  console.log(`[${projectId}] Creating Web app…`);

  // 1) Open wizard and register with projectId as nickname
  await openWebAppWizard(driver, projectId);
  await registerWebApp(driver, projectId);
  await finalizeWebAppWizard(driver, projectId);

  // 2) Ensure Authentication is initialized
  await ensureAuthInitialized(driver, projectId);

  await S(1200); // let backend finish wiring the key

  // 3) Now poll Settings → General (with refresh) until the key appears
  let apiKey = '';
  try {
    apiKey = await fetchApiKeyFromSettings(driver, projectId);
  } catch (e) {
    console.error(`[${projectId}] Failed to fetch API key: ${e.message}`);
    await dumpDebug(driver, `apikey-${projectId}`);
    return;
  }

  // 4) Save "<API_KEY> <EMAIL> <PROJECT_ID>"
  const line = `${apiKey} ${email} ${projectId}\n`;
  fs.appendFileSync(OUTPUT_FILE, line, 'utf8');
  console.log(`[${projectId}] Saved -> ${OUTPUT_FILE} : ${line.trim()}`);
}


/* ====== Open Auth and Get Started ====== */
async function openAuthAndGetStarted(driver, projectId) {
  await goto(driver, `https://console.firebase.google.com/project/${projectId}/authentication/users`);
  const getStarted = By.xpath("//button[contains(., 'Get started') or contains(., 'Get Started')]");
  const btns = await driver.findElements(getStarted);
  if (btns.length) {
    try { await safeClick(driver, getStarted, 15000); await waitPageStable(driver); }
    catch { console.log('Get started button present but not clickable, continuing.'); }
  }
}

/* ====== Runner per user ====== */
function getJWT(impersonate, saJson) {
  return new google.auth.JWT({
    email: saJson.client_email,
    key: saJson.private_key,
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/identitytoolkit",
      "https://www.googleapis.com/auth/firebase",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    subject: impersonate,
  });
}
async function safeListUserProjects(resourceManager) {
  const out = [];
  let pageToken;
  do {
    const { data } = await resourceManager.projects.list({ pageToken, pageSize: 1000 });
    (data.projects || []).forEach((p) => out.push(p));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

async function getRemainingProjectQuotaFree(resourceManager, userEmail, desiredCount) {
  const all = await safeListUserProjects(resourceManager);
  const remaining = Math.max(0, 12 - all.length);
  return { remaining, existing: all.map((p) => p.projectId) };
}
async function runForUser(user) {
  const driver = await buildDriver();
  try {
    console.log(`\n=== Working on ${user.email} ===`);
    try {
      await loginGoogle(driver, user.email, user.password);
    } catch (e) {
      await dumpDebug(driver, `login-${user.userBase}`);
      throw e;
    }

    const auth = getJWT(impersonateEmail, saJson);
    await auth.authorize();
    const resourceManager = google.cloudresourcemanager({ version: "v1", auth });
    const firebase = google.firebase({ version: "v1beta1", auth });
    const serviceUsage = google.serviceusage({ version: "v1", auth });

    const { remaining, existing } = await getRemainingProjectQuotaFree(resourceManager, impersonateEmail, 12);
    for (let i = 1; i <= 12; i++) {
      const projectId = existing[i-1];
      if (remaining <= 0) {
        console.log(`No remaining project quota for ${impersonateEmail}`);
        continue;
      } else {
        console.log(`→ Creating project: ${projectId}`);
        try {
          // Ensure console language is set to English (US) before creating the project
          await changeFirebaseConsoleLanguage(driver);
          await createFirebaseProject(driver, projectId);
        } catch (e) {
          console.error(`Create failed for ${projectId}: ${e.message}`);
          await dumpDebug(driver, `create-${projectId}`);
          continue;
        }
      }

      // Create web app and capture API key + appId (we save API key as you requested)
      try {
        await createWebAppAndSave(driver, projectId, user.email);
      } catch (e) {
        console.error(`Web app creation failed for ${projectId}: ${e.message}`);
        await dumpDebug(driver, `web-${projectId}`);
      }
    }
  } catch (e) {
    console.error(`User ${user.email} failed: ${e.message}`);
    await dumpDebug(driver, `user-${user.userBase}`);
  } finally {
    await driver.quit();
  }
}

async function runUsersWithPool(users, concurrency = 2) {
  let next = 0;

  async function worker(workerId) {
    while (true) {
      const i = next++;
      if (i >= users.length) break;

      const u = users[i];
      console.log(`\n[W${workerId}] -> ${u.email}`);
      try {
        await runForUser(u); // this builds its own driver and cleans it up
      } catch (e) {
        console.error(`[W${workerId}] ${u.email} error: ${e?.message || e}`);
      }
    }
  }

  const n = Math.min(concurrency, users.length);
  await Promise.all(Array.from({ length: n }, (_, k) => worker(k + 1)));
}

/* ====== Main ====== */
(async function main() {
  // const users = parseUsers();
  const users = [];
  for (let i = 1; i < 5000; i++) {// 96
        const u = {
            email: `user${i}@${DOMAIN}`,
            password: `SecurePassw0rd!`,
            userBase: `user${i}`
        }
        // Optional: limit to your pattern (e.g., user576..user599@DOMAIN)
        // if (!/^user(57[6-9]|58\d|59\d)@/.test(u.email)) continue;
        users.push(u);
    }
  if (!users.length) {
    console.log('No valid users in emails.txt');
    return;
  }

  console.log(`Starting with CONCURRENCY=${CONCURRENCY} for ${users.length} user(s)`);
  await runUsersWithPool(users, CONCURRENCY);

  console.log('\nAll done.');
})();
