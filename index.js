process.env.TZ = 'Asia/Kolkata';

const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');

let sharedBrowser = null;
let browserStarting = null;

const app = express();
app.use(express.json({ limit: '50mb' }));

const FIXED_BASE_URL = 'https://ballyfin.in';

const axiosInstance = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: process.env.ALLOW_INSECURE_TLS === 'true' ? false : true }),
    timeout: 20000
});

const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
    res.send('E-Visitor Automation Scraper is Active & Fast (Playwright)!');
});

async function sendCallback(callbackUrl, payload) {
    if (!callbackUrl) {
        console.log('callback_url nahi diya gaya.');
        return false;
    }

    try {
        console.log('Callback sending:', callbackUrl);
        const response = await axiosInstance.post(callbackUrl, payload, {
            timeout: 15000,
            headers: { 'Content-Type': 'application/json' },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        console.log('Callback success:', response.status);
        return true;
    } catch (error) {
        console.error('Callback failed:', error.message);
        return false;
    }
}

function startCreateVisitorBackground(auth_storage, booking_data, callback_url) {
    setImmediate(async () => {
        try {
            console.log('BACKGROUND CREATE VISITOR STARTED');
            const result = await processCreateVisitor(auth_storage, booking_data);
            console.log('Background process completed:', result.status);

            if (callback_url) {
                await sendCallback(callback_url, {
                    status: result.status,
                    message: result.message || '',
                    updated_person_ids: result.updated_person_ids || [],
                    screenshot: result.screenshot || null,
                    error_screenshot: result.error_screenshot || null,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error) {
            console.error('Background process fatal error:', error);
            if (callback_url) {
                await sendCallback(callback_url, {
                    status: 'failed',
                    message: error.message || 'Background automation failed',
                    updated_person_ids: [],
                    screenshot: null,
                    error_screenshot: null,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });
}

async function getBrowser() {
    if (sharedBrowser && sharedBrowser.isConnected()) {
        return sharedBrowser;
    }

    if (browserStarting) {
        return await browserStarting;
    }

    browserStarting = (async () => {
        const browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run'
            ]
        });

        browser.on('disconnected', () => {
            console.log('Browser disconnected, resetting reference...');
            sharedBrowser = null;
        });

        return browser;
    })();

    try {
        sharedBrowser = await browserStarting;
        return sharedBrowser;
    } finally {
        browserStarting = null;
    }
}

// -------------------------------------------------------------
// EVISITOR AUTH STORAGE HELPERS
// -------------------------------------------------------------

function normalizeAuthStorage(auth_storage) {
    let storageData = auth_storage;

    if (storageData && storageData.auth_storage) {
        storageData = storageData.auth_storage;
    }

    return storageData || null;
}

async function createAuthenticatedContext(auth_storage) {
    const browser = await getBrowser();

    const context = await browser.newContext({
        viewport: {
            width: 1366,
            height: 900
        },
        timezoneId: 'Asia/Kolkata',
        serviceWorkers: 'block'
    });

    const storageData = normalizeAuthStorage(auth_storage);

    if (storageData) {
        // Cookies
        if (Array.isArray(storageData.cookies) && storageData.cookies.length > 0) {
            await context.addCookies(storageData.cookies);
        }

        // localStorage + sessionStorage
        await context.addInitScript((storage) => {
            try {
                if (storage.localStorage) {
                    for (const [key, value] of Object.entries(storage.localStorage)) {
                        window.localStorage.setItem(key, value);
                    }
                }

                if (storage.sessionStorage) {
                    for (const [key, value] of Object.entries(storage.sessionStorage)) {
                        window.sessionStorage.setItem(key, value);
                    }
                }
            } catch (e) {
                // ignore
            }
        }, storageData);
    }

    return {
        context,
        storageData
    };
}

/*
|--------------------------------------------------------------------------
| SESSION CHECK
|--------------------------------------------------------------------------
|
| true  = session active
| false = expired / login page
|
*/

async function isEvisitorSessionValid(page) {
    await page.waitForSelector('body', { timeout: 15000 });
    await page.waitForTimeout(800);

    const loginVisible = await page
        .locator('input[placeholder="Enter SSO ID"]')
        .isVisible({ timeout: 1500 })
        .catch(() => false);

    const currentUrl = page.url();

    if (loginVisible || /\/login/i.test(currentUrl)) {
        return false;
    }

    /*
     * Visitors page ka marker.
     */
    const visitorsPageVisible = await page
        .getByText('Visitors List', { exact: false })
        .first()
        .isVisible({ timeout: 2500 })
        .catch(() => false);

    return visitorsPageVisible;
}

/*
|--------------------------------------------------------------------------
| React / MUI Input Fill
|--------------------------------------------------------------------------
*/

async function fillReactInput(page, selector, value) {
    if (value === undefined || value === null) {
        return;
    }

    const stringValue = String(value);

    await page.waitForSelector(selector, {
        state: 'visible',
        timeout: 10000
    });

    await page.evaluate(
        ({ selector, value }) => {
            const input = document.querySelector(selector);

            if (!input) {
                throw new Error('Input not found: ' + selector);
            }

            const prototype =
                input.tagName === 'TEXTAREA'
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;

            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

            if (setter) {
                setter.call(input, value);
            } else {
                input.value = value;
            }

            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
        },
        {
            selector,
            value: stringValue
        }
    );
}

/*
|--------------------------------------------------------------------------
| datetime-local formatter
|--------------------------------------------------------------------------
|
| Input:
|
| 2026-10-03 17:50:00
| 2026-10-03T17:50
| 2026-10-03T17:50:00
|
| Output:
|
| 2026-10-03T17:50
|
*/

function formatDateTimeLocal(value) {
    if (!value) {
        return '';
    }

    let output = String(value).trim();

    /*
     * Space -> T
     */
    output = output.replace(' ', 'T');

    /*
     * timezone/remove seconds if present
     */
    const match = output.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);

    if (!match) {
        return '';
    }

    return match[1] + 'T' + match[2];
}

app.get('/debug-view', async (req, res) => {
    let browser = null;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        await page.goto('https://evisitor.rajasthan.gov.in/evisitor', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        const screenshotBuffer = await page.screenshot({ fullPage: true });
        res.set('Content-Type', 'image/png');
        return res.send(screenshotBuffer);
    } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

async function downloadImage(url, destPath) {
    if (!url) return false;
    try {
        const writer = fs.createWriteStream(destPath);
        const response = await axiosInstance({
            url,
            method: 'GET',
            responseType: 'stream'
        });
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(true));
            writer.on('error', (err) => {
                writer.close();
                reject(err);
            });
        });
    } catch (err) {
        console.error('Image Download Failed:', url, err.message);
        return false;
    }
}

// -------------------------------------------------------------
// SCRAPE ENDPOINT
// -------------------------------------------------------------
app.all('/scrape', async (req, res) => {
    const targetUrl = req.query.url || req.body.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'URL parameter missing hai' });
    }

    let browser = null;
    let context = null;

    try {
        browser = await getBrowser();
        context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();

        await page.route('**/*', (route) => {
            const resource = route.request().resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resource)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        await page.goto(targetUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        });

        try {
            await page.waitForSelector('body', { timeout: 5000 });
        } catch (e) {
            console.log('Element wait timeout, proceeding anyway...');
        }

        const htmlContent = await page.content();
        await context.close();

        return res.send(htmlContent);
    } catch (error) {
        if (context) await context.close();
        return res.status(500).json({ error: 'Automation Error: ' + error.message });
    }
});

// -------------------------------------------------------------
// LOGIN EVISITOR ENDPOINT (SESSION GENERATOR)
// -------------------------------------------------------------
app.post('/login-evisitor', async (req, res) => {
    const { url, sso_id, password } = req.body;
    const loginBaseUrl = url || 'https://evisitor.rajasthan.gov.in/evisitor';
    let context = null;

    try {
        const browser = await getBrowser();
        context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();

        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'font', 'media'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        console.log('Navigating to login page. Starting login automation...');
        await page.goto(loginBaseUrl, { waitUntil: 'load', timeout: 35000 });

        const topLoginBtn = page.locator('button.login-btn').first();
        if (await topLoginBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await topLoginBtn.click();
        }

        const ssoInput = page.locator('input[placeholder="Enter SSO ID"]');
        await ssoInput.waitFor({ timeout: 10000 });

        try {
            await page.waitForSelector('.css-uayl0r', { timeout: 3000 });
        } catch (e) {
            console.log('Captcha selector wait timeout, evaluating DOM...');
        }

        const captchaCode = await page.evaluate(() => {
            const el = document.querySelector('.css-uayl0r');
            if (el && el.innerText.trim()) return el.innerText.trim();

            const captchaInput = document.querySelector('input[placeholder="Enter Captcha"]');
            if (captchaInput) {
                const parentBox = captchaInput.closest('.css-1tx38fa');
                if (parentBox) {
                    const textDiv = parentBox.querySelector('.MuiBox-root');
                    if (textDiv) return textDiv.innerText.trim();
                }
            }
            return null;
        });

        if (!captchaCode) {
            throw new Error('CAPTCHA code DOM me load nahi ho paya. Refresh karke try karein.');
        }

        await page.click('input[placeholder="Enter SSO ID"]', { clickCount: 3 });
        await page.locator('input[placeholder="Enter SSO ID"]').fill(sso_id);

        await page.click('input[placeholder="Enter Password"]', { clickCount: 3 });
        await page.locator('input[placeholder="Enter Password"]').fill(password);

        await page.click('input[placeholder="Enter Captcha"]', { clickCount: 3 });
        await page.locator('input[placeholder="Enter Captcha"]').fill(captchaCode);

        const submitBtn = page.locator('button:has-text("Submit")').first();
        if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await submitBtn.click();
        }

        let toastData = { success: false, message: '' };
        try {
            await page.waitForSelector('.Toastify__toast', { timeout: 4000 });
            toastData = await page.evaluate(() => {
                const toastEl = document.querySelector('.Toastify__toast');
                if (!toastEl) return { success: false, message: '' };
                const text = toastEl.innerText ? toastEl.innerText.trim() : '';
                const isSuccessClass = toastEl.classList.contains('Toastify__toast--success');
                const isSuccessText = text.toLowerCase().includes('success') || text.toLowerCase().includes('successful');
                return { success: isSuccessClass || isSuccessText, message: text };
            });
        } catch (e) {
            console.log('Toast wait complete.');
        }

        if (toastData.message && !toastData.success) {
            await context.close();
            return res.status(400).json({
                status: 'login_failed',
                toast_message: toastData.message,
                captcha_used: captchaCode
            });
        }

        await page.waitForFunction(() => !document.querySelector('.login-card'), { timeout: 10000 }).catch(() => null);
        await new Promise(resolve => setTimeout(resolve, 4000));

        const nextPageHtml = await page.content();
        const allCookies = await context.cookies();

        const authStorage = await page.evaluate(() => {
            const localData = {};
            const sessionData = {};

            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                localData[key] = localStorage.getItem(key);
            }

            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                sessionData[key] = sessionStorage.getItem(key);
            }

            return {
                localStorage: localData,
                sessionStorage: sessionData
            };
        });

        // IMPORTANT: visitor automation ko complete authenticated session chahiye.
        // Sirf local/session storage enough nahi hota; cookies bhi restore honi chahiye.
        authStorage.cookies = allCookies;

        await context.close();

        return res.json({
            status: 'success',
            toast_message: toastData.message || 'Login Successful',
            captcha_used: captchaCode,
            cookies: allCookies,
            auth_storage: authStorage,
            next_page_html: nextPageHtml
        });
    } catch (error) {
        if (context) await context.close();
        return res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

// -------------------------------------------------------------
// CREATE VISITOR AUTOMATION MAIN ENGINE
// -------------------------------------------------------------
async function processCreateVisitor(auth_storage, booking_data) {
    const visitorsUrl = 'https://evisitor.rajasthan.gov.in/evisitor/user/visitors';
    let browser = null;
    let context = null;
    let page = null; 
    let tempFiles = [];
    const updatedPersonIds = [];

    try {
        browser = await getBrowser();
        context = await browser.newContext({
            viewport: { width: 1366, height: 900 },
            timezoneId: 'Asia/Kolkata',
            serviceWorkers: 'block'
        });

        let storageData = auth_storage;
        if (storageData && storageData.auth_storage) {
            storageData = storageData.auth_storage;
        }

        if (storageData) {
            // Restore cookies first. This is required if the portal keeps login in cookies.
            if (Array.isArray(storageData.cookies) && storageData.cookies.length > 0) {
                await context.addCookies(storageData.cookies);
            }

            // Restore localStorage/sessionStorage on every document navigation.
            await context.addInitScript((storage) => {
                try {
                    if (storage.localStorage) {
                        for (const [key, value] of Object.entries(storage.localStorage)) {
                            window.localStorage.setItem(key, value);
                        }
                    }
                    if (storage.sessionStorage) {
                        for (const [key, value] of Object.entries(storage.sessionStorage)) {
                            window.sessionStorage.setItem(key, value);
                        }
                    }
                } catch (e) {}
            }, storageData);
        }

        page = await context.newPage();

        console.log('Navigating to base portal...');
        try {
            await page.goto('https://evisitor.rajasthan.gov.in/evisitor', { 
                waitUntil: 'domcontentloaded', 
                timeout: 30000 
            });
        } catch (e) {}

        if (storageData) {
            await page.evaluate((storage) => {
                if (storage.localStorage) {
                    Object.keys(storage.localStorage).forEach(k => localStorage.setItem(k, storage.localStorage[k]));
                }
                if (storage.sessionStorage) {
                    Object.keys(storage.sessionStorage).forEach(k => sessionStorage.setItem(k, storage.sessionStorage[k]));
                }
            }, storageData);
        }

        console.log('Navigating to Visitors Page...');
        await page.goto(visitorsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

        await page.waitForSelector('body', { timeout: 15000 });
        await page.waitForTimeout(1000);

        // Fail fast if restored auth is invalid/expired and portal redirects to login.
        const loginVisible = await page.locator('input[placeholder="Enter SSO ID"]').isVisible({ timeout: 1500 }).catch(() => false);
        if (loginVisible || /login/i.test(page.url())) {
            throw new Error('EVISITOR_SESSION_EXPIRED: auth_storage/cookies invalid ya expire ho chuke hain. Pehle /login-evisitor dobara call karein.');
        }

        const clickButtonSmart = async ({ texts, fallbackIndex = null, label }) => {

            // 1. FIRST PRIORITY: Button Index
            if (fallbackIndex !== null) {
                console.log(
                    `${label}: pehle button index ${fallbackIndex} check kar rahe hain...`
                );
        
                const indexResult = await page.evaluate((idx) => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const btn = buttons[idx];
                    console.log(btn);
        
                    if (!btn) {
                        return {
                            clicked: false,
                            reason: 'button_not_found'
                        };
                    }
        
                    const rect = btn.getBoundingClientRect();
        
                    const isVisible =
                        rect.width > 0 &&
                        rect.height > 0;
        
                    if (!isVisible) {
                        return {
                            clicked: false,
                            reason: 'button_not_visible'
                        };
                    }
        
                    if (btn.disabled) {
                        return {
                            clicked: false,
                            reason: 'button_disabled'
                        };
                    }
        
                    btn.scrollIntoView({
                        behavior: 'instant',
                        block: 'center'
                    });
        
                    btn.click();
        
                    return {
                        clicked: true,
                        text: (btn.textContent || '').trim()
                    };
        
                }, fallbackIndex);
        
                if (indexResult.clicked) {
                    console.log(
                        `${label}: button index ${fallbackIndex} se click ho gaya. Button text: "${indexResult.text}"`
                    );
        
                    return true;
                }
        
                console.warn(
                    `${label}: button index ${fallbackIndex} fail hua (${indexResult.reason}). Ab text selector try karenge.`
                );
            }
        
        
            // 2. SECOND PRIORITY: Text Selector
            for (const text of texts) {
        
                const btn = page
                    .getByRole('button', {
                        name: text,
                        exact: false
                    })
                    .first();
        
                if (
                    await btn
                        .isVisible({ timeout: 1200 })
                        .catch(() => false)
                ) {
        
                    await btn.scrollIntoViewIfNeeded();
        
                    await btn.click();
        
                    console.log(
                        `${label}: text selector se click ho gaya: ${text}`
                    );
        
                    return true;
                }
            }
        
        
            // 3. DONO FAIL
            throw new Error(
                `${label} button DOM me nahi mila. Index ${fallbackIndex} aur text selector dono fail.`
            );
        };

        // Check if Modal is already open
        let isModalOpen = await page.evaluate(() => !!document.querySelector('input[name="roomNumber"]'));

        if (!isModalOpen) {
            console.log('Modal band hai. Create Visitor button click kar rahe hain...');
            try {
                await clickButtonSmart({
                    texts: [/create visitor/i, /create check-?in/i, /^check-?in$/i],
                    fallbackIndex: 2,
                    label: 'Create Visitor'
                });
            } catch (buttonError) {
                const visitorsMenu = page.getByText('Visitors', { exact: true }).first();
                if (await visitorsMenu.isVisible({ timeout: 1500 }).catch(() => false)) {
                    await visitorsMenu.click();
                    await page.waitForTimeout(500);
                    await clickButtonSmart({
                        texts: [/create visitor/i, /create check-?in/i, /^check-?in$/i],
                        fallbackIndex: 2,
                        label: 'Create Visitor'
                    });
                } else {
                    throw buttonError;
                }
            }

            await page.waitForSelector('input[name="roomNumber"]', { state: 'visible', timeout: 15000 });
        } else {
            console.log('Modal pehle se open hai. Direct form fill shuru kar rahe hain.');
        }

        const fillReactInput = async (selector, value) => {
            if (value === undefined || value === null || value === '') return;
            await page.waitForSelector(selector, { state: 'visible', timeout: 7000 });
            await page.evaluate(({ sel, val }) => {
                const el = document.querySelector(sel);
                if (!el) return;
                try { el.removeAttribute('disabled'); } catch (e) {}
                const isTa = el.tagName === 'TEXTAREA';
                const setter = Object.getOwnPropertyDescriptor((isTa ? HTMLTextAreaElement : HTMLInputElement).prototype, 'value')?.set;
                if (setter) setter.call(el, val);
                else el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
            }, { sel: selector, val: String(value) });
        };

        const selectMuiDropdown = async (dropdownId, targetText) => {
            if (!targetText) return;
            const dropdown = page.locator(`#${dropdownId}`);
            await dropdown.waitFor({ state: 'visible', timeout: 7000 });
            await dropdown.click();
            await page.waitForTimeout(300);

            await page.waitForSelector('li[role="option"]', { state: 'visible', timeout: 7000 });
            const optionClicked = await page.evaluate((textToMatch) => {
                const norm = v => String(v || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
                const need = norm(textToMatch);
                const options = Array.from(document.querySelectorAll('li[role="option"]'));
                
                let found = options.find(o => norm(o.innerText) === need);
                if (!found) {
                    found = options.find(o => norm(o.innerText).includes(need));
                }

                if (found) {
                    found.scrollIntoView({ behavior: 'instant', block: 'center' });
                    found.click();
                    return true;
                }
                return false;
            }, targetText);

            if (!optionClicked) {
                await page.keyboard.press('Escape');
                console.warn(`Dropdown option "${targetText}" not found for #${dropdownId}`);
            }
            await page.waitForTimeout(300);
        };

        // 1. FILL ROOM / BASE DETAILS
        console.log('Filling Room Details...');
        if (booking_data.room_number) {
            await fillReactInput('input[name="roomNumber"]', booking_data.room_number);
        }

        if (booking_data.check_in_date_time) {
            let formattedCheckIn = booking_data.check_in_date_time;
            if (formattedCheckIn.includes(' ') && !formattedCheckIn.includes('T')) {
                formattedCheckIn = formattedCheckIn.replace(' ', 'T');
            }
            await fillReactInput('input[name="checkInDateTime"]', formattedCheckIn);
        }

        if (booking_data.coming_from) {
            await fillReactInput('input[name="comingLocation"]', booking_data.coming_from);
        }

        if (booking_data.going_to) {
            await fillReactInput('input[name="goingLocation"]', booking_data.going_to);
        }

        if (booking_data.visit_reason || booking_data.visit_reason_type) {
            await selectMuiDropdown('mui-component-select-visitReasonType', booking_data.visit_reason || booking_data.visit_reason_type);
        }

        if (booking_data.note) {
            await fillReactInput('textarea[name="note"]', booking_data.note);
        }

        // 2. FILL GUEST(S) DETAILS
        const guests = booking_data.guests || [];
        console.log(`Processing ${guests.length} guest(s)...`);

        for (let i = 0; i < guests.length; i++) {
            const guest = guests[i];
            console.log(`Filling details for Guest ${i + 1}: ${guest.full_name || guest.name}`);

            await fillReactInput('input[name="name"]', guest.full_name || guest.name || guest.guest_name);

            if (guest.dateOfBirth || guest.dob) {
                await fillReactInput('input[name="dateOfBirth"]', guest.dateOfBirth || guest.dob);
            }

            if (guest.email) {
                await fillReactInput('input[name="email"]', guest.email);
            }

            if (guest.gender) {
                let gText = 'Male';
                const lowerG = String(guest.gender).trim().toLowerCase();
                if (lowerG === 'female' || lowerG === 'f') gText = 'Female';
                else if (lowerG === 'other' || lowerG === 'o') gText = 'Other';
                await selectMuiDropdown('mui-component-select-gender', gText);
            }

            if (guest.mobile_number || guest.mobile) {
                await fillReactInput('input[name="mobileNumber"]', guest.mobile_number || guest.mobile);
            }

            if (guest.state || guest.stateCd) {
                await selectMuiDropdown('mui-component-select-stateCd', guest.state || guest.stateCd);
                await page.waitForTimeout(500);
            }

            if (guest.district || guest.districtcd) {
                await selectMuiDropdown('mui-component-select-districtcd', guest.district || guest.districtcd);
                await page.waitForTimeout(300);
            }

            if (guest.pscode || guest.police_station) {
                await selectMuiDropdown('mui-component-select-pscode', guest.pscode || guest.police_station);
            }

            const docType = guest.document_type || guest.documentType || guest.id_type || '';
            if (docType) {
                await selectMuiDropdown('mui-component-select-documentType', docType);
                await page.waitForTimeout(500);
            }

            const isVoterIdDocument = (value) => {
                return String(value || '').trim().toLowerCase() === 'aadhaar card';
            };

            const docNumber = guest.document_number || guest.documentNumber || guest.id_number || guest.doc_number;
            if (isVoterIdDocument(docType)) {
                if (docNumber) {
                    await fillReactInput('input[name="documentNumber"]', docNumber);
                }
            }

            if (guest.address) {
                await fillReactInput('textarea[name="address"]', guest.address);
            }

            // Document File Upload
            const uploadSingleDocument = async (docUrl, guestIndex, fileIndex) => {
                if (!docUrl) return;
            
                // Relative URL ko full URL me convert karo
                if (typeof docUrl === 'string' && docUrl.startsWith('/')) {
                    docUrl = `${FIXED_BASE_URL}${docUrl}`;
                }
            
                if (
                    typeof docUrl !== 'string' ||
                    !docUrl.startsWith('http')
                ) {
                    throw new Error(
                        `Guest ${guestIndex + 1}: Invalid document URL`
                    );
                }
            
                // Extension detect
                const cleanUrl = docUrl.split('?')[0].toLowerCase();
            
                let ext = 'jpg';
            
                if (cleanUrl.endsWith('.pdf')) ext = 'pdf';
                else if (cleanUrl.endsWith('.png')) ext = 'png';
                else if (cleanUrl.endsWith('.jpeg')) ext = 'jpeg';
                else if (cleanUrl.endsWith('.jpg')) ext = 'jpg';
            
                const localDocPath = path.join(
                    '/tmp',
                    `doc_g${guestIndex + 1}_f${fileIndex + 1}_${Date.now()}.${ext}`
                );
            
                console.log(
                    `Downloading document ${fileIndex + 1} for Guest ${guestIndex + 1}:`,
                    docUrl
                );
            
                const ok = await downloadImage(docUrl, localDocPath);
            
                if (!ok || !fs.existsSync(localDocPath)) {
                    throw new Error(
                        `Guest ${guestIndex + 1}: Document ${fileIndex + 1} download failed`
                    );
                }
            
                // Minimum 25KB portal requirement
                const stats = fs.statSync(localDocPath);
            
                if (stats.size < 26000) {
                    const padding = Buffer.alloc(
                        26000 - stats.size,
                        0
                    );
            
                    fs.appendFileSync(localDocPath, padding);
                }
            
                tempFiles.push(localDocPath);
            
                const fileInput = page.locator(
                    'input[type="file"][accept*=".jpg"]'
                ).first();
            
                await fileInput.waitFor({
                    state: 'attached',
                    timeout: 10000
                });
            
                // Upload se pehle current chip count
                const chipSelector =
                    '.MuiChip-root.MuiChip-colorSuccess';
            
                const chipCountBefore = await page
                    .locator(chipSelector)
                    .count();
            
                // Existing toast count
                const toastCountBefore = await page
                    .locator('.Toastify__toast')
                    .count();
            
                console.log(
                    `Uploading document ${fileIndex + 1} for Guest ${guestIndex + 1}...`
                );
            
                // Ek file select karo
                await fileInput.setInputFiles(localDocPath);
            
                // -----------------------------------------------------
                // WAIT FOR NEW TOAST OR SUCCESS CHIP
                // -----------------------------------------------------
            
                try {
                    await page.waitForFunction(
                        ({ toastCountBefore, chipCountBefore }) => {
                            const toastCount =
                                document.querySelectorAll(
                                    '.Toastify__toast'
                                ).length;
            
                            const chipCount =
                                document.querySelectorAll(
                                    '.MuiChip-root.MuiChip-colorSuccess'
                                ).length;
            
                            return (
                                toastCount > toastCountBefore ||
                                chipCount > chipCountBefore
                            );
                        },
                        {
                            toastCountBefore,
                            chipCountBefore
                        },
                        {
                            timeout: 15000
                        }
                    );
            
                } catch (e) {
                    throw new Error(
                        `Guest ${guestIndex + 1}: Document ${fileIndex + 1} upload response timeout`
                    );
                }
            
                // Thoda UI settle hone do
                await page.waitForTimeout(400);
            
                // -----------------------------------------------------
                // CHECK NEWEST TOAST
                // -----------------------------------------------------
            
                const toastResult = await page.evaluate(() => {
                    const toasts = Array.from(
                        document.querySelectorAll(
                            '.Toastify__toast'
                        )
                    );
            
                    if (!toasts.length) {
                        return null;
                    }
            
                    const toast = toasts[toasts.length - 1];
            
                    const text =
                        (toast.innerText || '')
                            .trim();
            
                    const cls =
                        toast.className || '';
            
                    return {
                        message: text,
                        success:
                            cls.includes(
                                'Toastify__toast--success'
                            ),
                        error:
                            cls.includes(
                                'Toastify__toast--error'
                            )
                    };
                });
            
                if (toastResult) {
                    console.log(
                        `Upload toast: ${toastResult.message}`
                    );
            
                    if (toastResult.error) {
                        throw new Error(
                            `Guest ${guestIndex + 1}: Document ${fileIndex + 1} upload failed: ${toastResult.message}`
                        );
                    }
                }
            
                // -----------------------------------------------------
                // CONFIRM GREEN CHIP ADDED
                // -----------------------------------------------------
            
                try {
                    await page.waitForFunction(
                        (previousCount) => {
                            return (
                                document.querySelectorAll(
                                    '.MuiChip-root.MuiChip-colorSuccess'
                                ).length > previousCount
                            );
                        },
                        chipCountBefore,
                        {
                            timeout: 10000
                        }
                    );
            
                } catch (e) {
                    throw new Error(
                        `Guest ${guestIndex + 1}: Document ${fileIndex + 1} upload successful confirm nahi hua.`
                    );
                }
            
                const chipCountAfter = await page
                    .locator(chipSelector)
                    .count();
            
                console.log(
                    `Document ${fileIndex + 1} uploaded successfully. Chips: ${chipCountBefore} -> ${chipCountAfter}`
                );
            
                // Next document upload se pehle small delay
                await page.waitForTimeout(500);
            };
            
            
            // ---------------------------------------------------------
            // FRONT + BACK DOCUMENTS
            // ---------------------------------------------------------
            
            const documentUrls = [
                guest.document_url,
                guest.document_url_2
            ].filter(url => url);
            
            for (
                let d = 0;
                d < documentUrls.length;
                d++
            ) {
                await uploadSingleDocument(
                    documentUrls[d],
                    i,
                    d
                );
            }

            // Add guest: text-based selector first; numeric index only compatibility fallback.
            console.log(`Clicking 'Add' for Guest ${i + 1}...`);
            await clickButtonSmart({
                texts: [/^add$/i, /add guest/i, /add visitor/i],
                fallbackIndex: 4,
                label: `Guest ${i + 1} Add`
            });

            await page.waitForTimeout(1000);
            const errors = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.Mui-error, .MuiFormHelperText-root.Mui-error'))
                    .map(e => e.innerText.trim())
                    .filter(t => t.length > 0);
            });

            if (errors.length > 0) {
                const uniqueErrors = [...new Set(errors)].join(' | ');
                throw new Error(`Guest ${i + 1} validation failed: ${uniqueErrors}`);
            }

            if (guest.person_pk !== undefined && guest.person_pk !== null) {
                updatedPersonIds.push(guest.person_pk);
            }
        }

        // 3. FINAL SUBMIT CHECK-IN
console.log('Submitting Final Check-In...');

try {
    const result = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));

        console.log('Total Buttons:', buttons.length);

        const btn = buttons[9];

        if (!btn) {
            throw new Error(`button[9] nahi mila. Total buttons: ${buttons.length}`);
        }

        const text = (btn.textContent || '').trim();

        if (!/submit check-?in/i.test(text)) {
            console.log(`button[9] mila lekin text "${text}" hai`);
        }

        btn.scrollIntoView({
            block: 'center',
            behavior: 'instant'
        });

        btn.click();

        return {
            text,
            totalButtons: buttons.length
        };
    });

    console.log(
        `DIRECT SUBMIT SUCCESS: button[9] = "${result.text}", Total buttons = ${result.totalButtons}`
    );
} catch (directError) {
    console.error('DIRECT SUBMIT FAILED:', directError.message);
    console.log('Ab clickButtonSmart fallback try kar rahe hain...');

    await clickButtonSmart({
        texts: [
            /submit check-?in/i,
            /^submit$/i
        ],
        fallbackIndex: 9,
        label: 'Submit Check-In'
    });
}

        let toastMessage = '';
        let toastIsError = false;
        try {
            await page.waitForSelector('.Toastify__toast', { timeout: 8000 });
            const toast = await page.evaluate(() => {
                const el = document.querySelector('.Toastify__toast');
                if (!el) return { message: '', isError: false, isSuccess: false };
                const message = (el.innerText || '').trim();
                const cls = el.className || '';
                return {
                    message,
                    isError: cls.includes('Toastify__toast--error') || /error|failed|invalid|required/i.test(message),
                    isSuccess: cls.includes('Toastify__toast--success') || /success|successful|submitted|created/i.test(message)
                };
            });
            toastMessage = toast.message;
            toastIsError = toast.isError;
        } catch (e) {
            console.warn('Final submit toast nahi mila; DOM state verify kar rahe hain.');
        }

        if (toastIsError) {
            throw new Error(`Final check-in failed: ${toastMessage}`);
        }

        // If no success toast came, make sure validation errors are not present.
        const finalErrors = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.Mui-error, .MuiFormHelperText-root.Mui-error'))
                .map(e => (e.innerText || '').trim())
                .filter(Boolean);
        });
        if (finalErrors.length > 0) {
            throw new Error(`Final check-in validation failed: ${[...new Set(finalErrors)].join(' | ')}`);
        }

        if (!toastMessage) toastMessage = 'Visitor check-in submitted; no error was reported by the page.';

        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
        await context.close();
        context = null;

        return { status: 'success', message: toastMessage, updated_person_ids: updatedPersonIds };
    } catch (error) {
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });

        let errorScreenshotBase64 = null;
        if (page && !page.isClosed()) {
            try {
                const buffer = await page.screenshot({ fullPage: true });
                errorScreenshotBase64 = buffer.toString('base64');
            } catch (screenshotError) {
                console.error("Screenshot capture failed:", screenshotError);
            }
        }

        if (context) { try { await context.close(); } catch (e) {} }

        return { 
            status: 'failed', 
            message: error.message,
            error_screenshot: errorScreenshotBase64 ? `data:image/png;base64,${errorScreenshotBase64}` : null 
        };
    }
}

// -------------------------------------------------------------
// POST /create-visitor ENTRYPOINT
// -------------------------------------------------------------
app.post('/create-visitor', async (req, res) => {
    try {
        const { auth_storage, booking_data, callback_url } = req.body;

        if (!booking_data) {
            return res.status(400).json({ status: 'failed', message: 'booking_data required hai.' });
        }

        if (!booking_data.guests || !Array.isArray(booking_data.guests) || booking_data.guests.length === 0) {
            return res.status(400).json({ status: 'failed', message: 'booking_data.guests empty hai.' });
        }

        console.log('Create visitor request received. Guests:', booking_data.guests.length);

        // IMPORTANT FOR CLOUD RUN:
        // Work ko HTTP response ke baad setImmediate/background me mat chalao.
        // Request ko open rakho, automation complete karo, phir response/callback bhejo.
        const result = await processCreateVisitor(auth_storage, booking_data);

        if (callback_url) {
            await sendCallback(callback_url, {
                status: result.status,
                message: result.message || '',
                updated_person_ids: result.updated_person_ids || [],
                screenshot: result.screenshot || null,
                error_screenshot: result.error_screenshot || null,
                timestamp: new Date().toISOString()
            });
        }

        const httpStatus = result.status === 'success' ? 200 : 422;
        return res.status(httpStatus).json({
            ...result,
            callback_enabled: !!callback_url,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Create visitor request error:', error.message);
        return res.status(500).json({
            status: 'failed',
            message: error.message || 'Visitor automation failed.'
        });
    }
});

// -------------------------------------------------------------
// CHECKOUT VISITOR AUTOMATION
// -------------------------------------------------------------

function normalizeAuthStorage(auth_storage) {
    let storageData = auth_storage;

    if (storageData && storageData.auth_storage) {
        storageData = storageData.auth_storage;
    }

    return storageData || null;
}

async function createAuthenticatedContext(auth_storage) {
    const browser = await getBrowser();

    const context = await browser.newContext({
        viewport: {
            width: 1366,
            height: 900
        },
        timezoneId: 'Asia/Kolkata',
        serviceWorkers: 'block'
    });

    const storageData = normalizeAuthStorage(auth_storage);

    if (storageData) {
        // Cookies
        if (Array.isArray(storageData.cookies) && storageData.cookies.length > 0) {
            await context.addCookies(storageData.cookies);
        }

        // localStorage + sessionStorage
        await context.addInitScript((storage) => {
            try {
                if (storage.localStorage) {
                    for (const [key, value] of Object.entries(storage.localStorage)) {
                        window.localStorage.setItem(key, value);
                    }
                }

                if (storage.sessionStorage) {
                    for (const [key, value] of Object.entries(storage.sessionStorage)) {
                        window.sessionStorage.setItem(key, value);
                    }
                }
            } catch (e) {
                // ignore
            }
        }, storageData);
    }

    return {
        context,
        storageData
    };
}

/*
|--------------------------------------------------------------------------
| SESSION CHECK
|--------------------------------------------------------------------------
|
| true  = session active
| false = expired / login page
|
*/

async function isEvisitorSessionValid(page) {
    await page.waitForSelector('body', { timeout: 15000 });
    await page.waitForTimeout(800);

    const loginVisible = await page
        .locator('input[placeholder="Enter SSO ID"]')
        .isVisible({ timeout: 1500 })
        .catch(() => false);

    const currentUrl = page.url();

    if (loginVisible || /\/login/i.test(currentUrl)) {
        return false;
    }

    /*
     * Visitors page ka marker.
     */
    const visitorsPageVisible = await page
        .getByText('Visitors List', { exact: false })
        .first()
        .isVisible({ timeout: 2500 })
        .catch(() => false);

    return visitorsPageVisible;
}

/*
|--------------------------------------------------------------------------
| React / MUI Input Fill
|--------------------------------------------------------------------------
*/

async function fillReactInput(page, selector, value) {
    if (value === undefined || value === null) {
        return;
    }

    const stringValue = String(value);

    await page.waitForSelector(selector, {
        state: 'visible',
        timeout: 10000
    });

    await page.evaluate(
        ({ selector, value }) => {
            const input = document.querySelector(selector);

            if (!input) {
                throw new Error('Input not found: ' + selector);
            }

            const prototype =
                input.tagName === 'TEXTAREA'
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;

            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

            if (setter) {
                setter.call(input, value);
            } else {
                input.value = value;
            }

            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
        },
        {
            selector,
            value: stringValue
        }
    );
}

/*
|--------------------------------------------------------------------------
| datetime-local formatter
|--------------------------------------------------------------------------
|
| Input:
|
| 2026-10-03 17:50:00
| 2026-10-03T17:50
| 2026-10-03T17:50:00
|
| Output:
|
| 2026-10-03T17:50
|
*/

function formatDateTimeLocal(value) {
    if (!value) {
        return '';
    }

    let output = String(value).trim();

    /*
     * Space -> T
     */
    output = output.replace(' ', 'T');

    /*
     * timezone/remove seconds if present
     */
    const match = output.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);

    if (!match) {
        return '';
    }

    return match[1] + 'T' + match[2];
}

async function processCheckoutVisitor(auth_storage, checkout_data) {
    const visitorsUrl = 'https://evisitor.rajasthan.gov.in/evisitor/user/visitors';

    let context = null;
    let page = null;

    try {
        /*
        |--------------------------------------------------------------------------
        | Validation
        |--------------------------------------------------------------------------
        */

        const visitorName = String(
            checkout_data.visitorName || checkout_data.visitor_name || ''
        ).trim();

        const visitorMob = String(
            checkout_data.visitorMob || checkout_data.visitor_mobile || ''
        ).trim();

        const checkoutDateTime = formatDateTimeLocal(
            checkout_data.checkout_datetime ||
            checkout_data.checkOutDateTime ||
            checkout_data.checkoutDateTime
        );

        if (!visitorName) {
            return {
                status: 'failed',
                message: 'visitorName required hai.'
            };
        }

        if (!visitorMob) {
            return {
                status: 'failed',
                message: 'visitorMob required hai.'
            };
        }

        if (!checkoutDateTime) {
            return {
                status: 'failed',
                message: 'Valid checkout_datetime required hai.'
            };
        }

        /*
        |--------------------------------------------------------------------------
        | Browser Context + Auth Restore
        |--------------------------------------------------------------------------
        */

        const authResult = await createAuthenticatedContext(auth_storage);
        context = authResult.context;
        page = await context.newPage();

        console.log('CHECKOUT: Navigating to Visitors page...');

        await page.goto(visitorsUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 45000
        });

        /*
        |--------------------------------------------------------------------------
        | Session Expired Check
        |--------------------------------------------------------------------------
        */

        const sessionValid = await isEvisitorSessionValid(page);

        if (!sessionValid) {
            await context.close();
            context = null;

            return {
                status: 'failed',
                error_code: 'EVISITOR_SESSION_EXPIRED',
                message: 'Evisitor session expired. Please reconnect Evisitor.'
            };
        }

        console.log('CHECKOUT: Session valid.');

        /*
        |--------------------------------------------------------------------------
        | Fill Visitor Name
        |--------------------------------------------------------------------------
        |
        | Actual portal HTML:
        |
        | input[name="visitorName"]
        |
        */

        await fillReactInput(page, 'input[name="visitorName"]', visitorName);

        /*
        |--------------------------------------------------------------------------
        | Fill Visitor Mobile
        |--------------------------------------------------------------------------
        |
        | Actual:
        |
        | input[name="visitorMob"]
        |
        */

        await fillReactInput(page, 'input[name="visitorMob"]', visitorMob);

        console.log('CHECKOUT: Filters filled:', {
            visitorName,
            visitorMob
        });

        /*
        |--------------------------------------------------------------------------
        | APPLY BUTTON
        |--------------------------------------------------------------------------
        |
        | User requirement:
        | Apply button index 0
        |
        | First index try karenge,
        | text selector fallback hoga.
        |
        */

        let applyClicked = false;

        /*
         * INDEX 0
         */
        const applyByIndex = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const button = buttons[0];

            if (!button) {
                return false;
            }

            const text = (button.textContent || '').trim();

            /*
             * Safety:
             * button 0 Apply hi hona chahiye.
             */
            if (!/apply/i.test(text)) {
                return false;
            }

            const rect = button.getBoundingClientRect();

            if (rect.width <= 0 || rect.height <= 0 || button.disabled) {
                return false;
            }

            button.scrollIntoView({
                block: 'center',
                behavior: 'instant'
            });

            button.click();
            return true;
        });

        if (applyByIndex) {
            applyClicked = true;
            console.log('CHECKOUT: Apply button index 0 clicked.');
        }

        /*
         * Fallback text selector.
         */
        if (!applyClicked) {
            const applyButton = page
                .getByRole('button', {
                    name: 'Apply',
                    exact: true
                })
                .first();

            if (await applyButton.isVisible({ timeout: 3000 }).catch(() => false)) {
                await applyButton.click();
                applyClicked = true;
                console.log('CHECKOUT: Apply text selector clicked.');
            }
        }

        if (!applyClicked) {
            throw new Error('Apply button nahi mila.');
        }

        /*
        |--------------------------------------------------------------------------
        | Wait Filter Result
        |--------------------------------------------------------------------------
        */

        await page.waitForTimeout(1500);

        await page.waitForSelector('table tbody', {
            timeout: 10000
        });

        /*
        |--------------------------------------------------------------------------
        | Check Result List Empty?
        |--------------------------------------------------------------------------
        */

        const tableResult = await page.evaluate(
            ({ expectedName, expectedMobile }) => {
                const normalize = (value) =>
                    String(value || '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .toLowerCase();

                const tbody = document.querySelector('table tbody');

                if (!tbody) {
                    return {
                        hasRows: false,
                        rowCount: 0,
                        matchedIndex: -1
                    };
                }

                const rows = Array.from(tbody.querySelectorAll('tr'));

                if (rows.length === 0) {
                    return {
                        hasRows: false,
                        rowCount: 0,
                        matchedIndex: -1
                    };
                }

                /*
                 * Filter already name/mobile laga chuka hai,
                 * phir bhi name verify karna safer hai.
                 *
                 * Mobile portal masked ho sakta hai:
                 * 93******19
                 * isliye exact mobile comparison nahi.
                 */

                const nameNeed = normalize(expectedName);

                let matchedIndex = rows.findIndex((row) => {
                    const cells = Array.from(row.querySelectorAll('td'));

                    if (cells.length < 2) {
                        return false;
                    }

                    const rowName = normalize(cells[1]?.innerText);

                    return (
                        rowName === nameNeed ||
                        rowName.includes(nameNeed) ||
                        nameNeed.includes(rowName)
                    );
                });

                /*
                 * Name exact match na ho,
                 * filter result ka first row use karo.
                 */
                if (matchedIndex < 0 && rows.length > 0) {
                    matchedIndex = 0;
                }

                return {
                    hasRows: rows.length > 0,
                    rowCount: rows.length,
                    matchedIndex
                };
            },
            {
                expectedName: visitorName,
                expectedMobile: visitorMob
            }
        );

        console.log('CHECKOUT: Search result:', tableResult);

        if (!tableResult.hasRows || tableResult.matchedIndex < 0) {
            await context.close();
            context = null;

            return {
                status: 'failed',
                error_code: 'VISITOR_NOT_FOUND',
                message: 'Visitor search result empty hai.'
            };
        }

        /*
        |--------------------------------------------------------------------------
        | Click Check-Out button of matched row
        |--------------------------------------------------------------------------
        */

        const checkoutClicked = await page.evaluate((rowIndex) => {
            const rows = Array.from(document.querySelectorAll('table tbody tr'));
            const row = rows[rowIndex];

            if (!row) {
                return false;
            }

            const buttons = Array.from(row.querySelectorAll('button'));
            const checkoutButton = buttons.find((button) =>
                /check[\s-]*out/i.test((button.textContent || '').trim())
            );

            if (!checkoutButton || checkoutButton.disabled) {
                return false;
            }

            checkoutButton.scrollIntoView({
                block: 'center',
                behavior: 'instant'
            });

            checkoutButton.click();
            return true;
        }, tableResult.matchedIndex);

        if (!checkoutClicked) {
            throw new Error('Check-Out button result row me nahi mila.');
        }

        console.log('CHECKOUT: Check-Out clicked. Waiting modal...');

        /*
        |--------------------------------------------------------------------------
        | Wait Modal
        |--------------------------------------------------------------------------
        */

        const dialog = page.locator('div[role="dialog"]').last();

        await dialog.waitFor({
            state: 'visible',
            timeout: 10000
        });

        /*
        |--------------------------------------------------------------------------
        | Find Checkout datetime-local input
        |--------------------------------------------------------------------------
        |
        | First priority:
        |
        | #_r_40_
        |
        | But MUI generated ID dynamic ho sakti hai.
        |
        | Fallback:
        | dialog ke andar enabled datetime-local input
        |
        */

        let checkoutInput = dialog.locator('#_r_40_');
        let checkoutInputExists = await checkoutInput.count();

        if (checkoutInputExists === 0) {
            checkoutInput = dialog
                .locator('input[type="datetime-local"]:not([disabled])')
                .first();
        }

        await checkoutInput.waitFor({
            state: 'visible',
            timeout: 10000
        });

        /*
        |--------------------------------------------------------------------------
        | Portal min/max validation
        |--------------------------------------------------------------------------
        */

        const dateLimits = await checkoutInput.evaluate((input) => ({
            min: input.min || '',
            max: input.max || ''
        }));

        console.log('CHECKOUT datetime:', {
            requested: checkoutDateTime,
            min: dateLimits.min,
            max: dateLimits.max
        });

        /*
         * Browser side min/max ke bahar hai
         * to submit fail hoga.
         */
        if (dateLimits.min && checkoutDateTime < dateLimits.min) {
            throw new Error(
                `Checkout datetime ${checkoutDateTime} check-in datetime ${dateLimits.min} se pehle hai.`
            );
        }

        if (dateLimits.max && checkoutDateTime > dateLimits.max) {
            throw new Error(
                `Checkout datetime ${checkoutDateTime} portal max ${dateLimits.max} se aage hai.`
            );
        }

        /*
        |--------------------------------------------------------------------------
        | Fill datetime-local React Input
        |--------------------------------------------------------------------------
        */

        await checkoutInput.evaluate((input, value) => {
            const setter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value'
            )?.set;

            if (setter) {
                setter.call(input, value);
            } else {
                input.value = value;
            }

            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
        }, checkoutDateTime);

        /*
         * Verify actual DOM value.
         */
        const filledValue = await checkoutInput.inputValue();

        console.log('CHECKOUT: filled datetime-local:', filledValue);

        if (filledValue !== checkoutDateTime) {
            throw new Error('Checkout datetime input fill verify nahi hua.');
        }

        /*
        |--------------------------------------------------------------------------
        | Submit first checkout modal
        |--------------------------------------------------------------------------
        */
        
        const firstDialog = page
            .locator('div[role="dialog"]')
            .filter({
                hasText: 'Please select check-out date and time'
            })
            .first();
        
        const submitButton = firstDialog
            .getByRole('button', {
                name: 'Submit',
                exact: true
            })
            .first();
        
        await submitButton.waitFor({
            state: 'visible',
            timeout: 7000
        });
        
        if (await submitButton.isDisabled().catch(() => false)) {
            throw new Error('Checkout Submit button disabled hai.');
        }
        
        /*
         * Click first Submit.
         *
         * IMPORTANT:
         * Isse checkout complete nahi hota.
         * Confirmation modal open hota hai.
         */
        await submitButton.click();
        
        console.log('CHECKOUT: First Submit clicked. Waiting confirmation modal...');
        
        /*
        |--------------------------------------------------------------------------
        | WAIT CONFIRMATION MODAL
        |--------------------------------------------------------------------------
        |
        | Portal HTML:
        |
        | Are you sure you want to check-out?
        |
        | Yes, Confirm
        | Cancel
        |
        */
        
        const confirmDialog = page
            .locator('div[role="dialog"]')
            .filter({
                hasText: 'Are you sure you want to check-out?'
            })
            .last();
        
        await confirmDialog.waitFor({
            state: 'visible',
            timeout: 10000
        });
        
        console.log('CHECKOUT: Confirmation modal opened.');
        
        /*
        |--------------------------------------------------------------------------
        | Find "Yes, Confirm"
        |--------------------------------------------------------------------------
        */
        
        const confirmButton = confirmDialog
            .getByRole('button', {
                name: 'Yes, Confirm',
                exact: true
            })
            .first();
        
        await confirmButton.waitFor({
            state: 'visible',
            timeout: 7000
        });
        
        if (await confirmButton.isDisabled().catch(() => false)) {
            throw new Error('Yes, Confirm button disabled hai.');
        }
        
        /*
        |--------------------------------------------------------------------------
        | Existing Toast Count
        |--------------------------------------------------------------------------
        */
        
        const toastCountBefore = await page.locator('.Toastify__toast').count();
        
        /*
        |--------------------------------------------------------------------------
        | FINAL CONFIRM CLICK
        |--------------------------------------------------------------------------
        */
        
        await confirmButton.click();
        
        console.log('CHECKOUT: Yes, Confirm clicked.');
        
        /*
        |--------------------------------------------------------------------------
        | Wait for actual checkout result
        |--------------------------------------------------------------------------
        |
        | Success me:
        |
        | - confirm modal close hoga
        | - checkout modal bhi close ho sakta hai
        | - toast aa sakta hai
        |
        */
        
        await Promise.race([
            /*
             * New toast
             */
            page.waitForFunction(
                (previousCount) => {
                    return (
                        document.querySelectorAll('.Toastify__toast').length >
                        previousCount
                    );
                },
                toastCountBefore,
                {
                    timeout: 15000
                }
            ),
        
            /*
             * Confirmation modal hidden
             */
            confirmDialog.waitFor({
                state: 'hidden',
                timeout: 15000
            })
        ]).catch(() => null);
        
        await page.waitForTimeout(800);
        
        /*
        |--------------------------------------------------------------------------
        | Read Latest Toast
        |--------------------------------------------------------------------------
        */
        
        const checkoutResult = await page.evaluate(() => {
            const toasts = Array.from(document.querySelectorAll('.Toastify__toast'));
        
            if (toasts.length === 0) {
                return {
                    message: '',
                    success: false,
                    error: false
                };
            }
        
            const toast = toasts[toasts.length - 1];
            const message = (toast.innerText || '').trim();
            const cls = toast.className || '';
            const lowerMessage = message.toLowerCase();
        
            return {
                message,
                success:
                    cls.includes('Toastify__toast--success') ||
                    lowerMessage.includes('success') ||
                    lowerMessage.includes('checked-out') ||
                    lowerMessage.includes('checkout'),
                error:
                    cls.includes('Toastify__toast--error') ||
                    lowerMessage.includes('error') ||
                    lowerMessage.includes('failed') ||
                    lowerMessage.includes('invalid')
            };
        });
        
        console.log('CHECKOUT final response:', checkoutResult);
        
        /*
        |--------------------------------------------------------------------------
        | Explicit Error Toast
        |--------------------------------------------------------------------------
        */
        
        if (checkoutResult.error) {
            throw new Error(checkoutResult.message || 'Evisitor checkout failed.');
        }
        
        /*
        |--------------------------------------------------------------------------
        | Check Confirmation Modal Closed
        |--------------------------------------------------------------------------
        */
        
        const confirmModalStillVisible = await confirmDialog
            .isVisible()
            .catch(() => false);
        
        if (confirmModalStillVisible) {
            throw new Error(
                'Checkout confirmation modal close nahi hua. Checkout confirm nahi hua.'
            );
        }
        
        /*
        |--------------------------------------------------------------------------
        | Additional verification
        |--------------------------------------------------------------------------
        |
        | Pehla datetime modal bhi ideally close ho jana chahiye.
        |
        */
        
        const firstModalStillVisible = await firstDialog
            .isVisible()
            .catch(() => false);
        
        if (firstModalStillVisible) {
            console.warn(
                'Checkout date modal abhi visible hai. Portal UI settle hone ka wait kar rahe hain.'
            );
        
            await page.waitForTimeout(1000);
        }
        
        /*
        |--------------------------------------------------------------------------
        | SUCCESS
        |--------------------------------------------------------------------------
        */
        
        await context.close();
        context = null;
        
        return {
            status: 'success',
            message: checkoutResult.message || 'Visitor checked-out successfully.',
            visitor_name: visitorName,
            visitor_mobile: visitorMob,
            checkout_datetime: checkoutDateTime
        };
    } catch (error) {
        console.error('CHECKOUT ERROR:', error);

        let errorScreenshotBase64 = null;

        if (page && !page.isClosed()) {
            try {
                const screenshot = await page.screenshot({ fullPage: true });
                errorScreenshotBase64 = screenshot.toString('base64');
            } catch (e) {
                console.error('Checkout screenshot failed:', e.message);
            }
        }

        if (context) {
            try {
                await context.close();
            } catch (e) {}
            context = null;
        }

        return {
            status: 'failed',
            message: error.message || 'Visitor checkout failed.',
            error_screenshot: errorScreenshotBase64
                ? 'data:image/png;base64,' + errorScreenshotBase64
                : null
        };
    }
}

// -------------------------------------------------------------
// POST /checkout-visitor
// -------------------------------------------------------------

app.post('/checkout-visitor', async (req, res) => {
    try {
        const { auth_storage, checkout_data } = req.body;

        if (!auth_storage) {
            return res.status(400).json({
                status: 'failed',
                message: 'auth_storage required hai.'
            });
        }

        if (!checkout_data) {
            return res.status(400).json({
                status: 'failed',
                message: 'checkout_data required hai.'
            });
        }

        if (!checkout_data.visitorName && !checkout_data.visitor_name) {
            return res.status(400).json({
                status: 'failed',
                message: 'visitorName required hai.'
            });
        }

        if (!checkout_data.visitorMob && !checkout_data.visitor_mobile) {
            return res.status(400).json({
                status: 'failed',
                message: 'visitorMob required hai.'
            });
        }

        if (
            !checkout_data.checkout_datetime &&
            !checkout_data.checkOutDateTime &&
            !checkout_data.checkoutDateTime
        ) {
            return res.status(400).json({
                status: 'failed',
                message: 'checkout_datetime required hai.'
            });
        }

        console.log('Checkout request received:', {
            visitorName: checkout_data.visitorName || checkout_data.visitor_name,
            visitorMob: checkout_data.visitorMob || checkout_data.visitor_mobile,
            checkout_datetime:
                checkout_data.checkout_datetime ||
                checkout_data.checkOutDateTime ||
                checkout_data.checkoutDateTime
        });

        /*
         * Synchronous checkout.
         */
        const result = await processCheckoutVisitor(auth_storage, checkout_data);

        /*
         * IMPORTANT:
         *
         * Session expired bhi status=failed
         * response me jayega.
         *
         * Laravel uske according
         * auto reconnect kar sakta hai.
         */

        const httpStatus = result.status === 'success' ? 200 : 422;

        return res.status(httpStatus).json({
            ...result,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Checkout endpoint error:', error);

        return res.status(500).json({
            status: 'failed',
            message: error.message || 'Checkout automation failed.',
            timestamp: new Date().toISOString()
        });
    }
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});

server.setTimeout(0);

async function shutdown(signal) {
    console.log(`${signal} received. Closing browser/server...`);
    try {
        if (sharedBrowser && sharedBrowser.isConnected()) await sharedBrowser.close();
    } catch (e) {
        console.error('Browser close error:', e.message);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
