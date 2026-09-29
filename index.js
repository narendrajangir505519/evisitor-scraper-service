process.env.TZ = 'Asia/Kolkata';

const express = require('express');
const { chromium } = require('playwright-core');
const sparticuzChromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');

let sharedBrowser = null;
let browserStarting = null;

const app = express();
app.use(express.json({ limit: '50mb' }));

const FIXED_BASE_URL = 'https://ballyfin.in';
const PORT = process.env.PORT || 3000;

const axiosInstance = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 20000
});

async function getBrowser() {
    // 1. Check if existing browser is still connected
    if (sharedBrowser && sharedBrowser.isConnected()) {
        return sharedBrowser;
    }

    if (browserStarting) {
        return await browserStarting;
    }

    browserStarting = (async () => {
        const executablePath = await sparticuzChromium.executablePath();

        // --single-process flag ko hatana zaroori hai kyunki ye crash karta hai
        const filteredArgs = sparticuzChromium.args.filter(
            arg => !arg.includes('--single-process')
        );

        const browser = await chromium.launch({
            args: [
                ...filteredArgs,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-sync',
                '--mute-audio'
            ],
            executablePath: executablePath || '/usr/bin/google-chrome',
            headless: true
        });

        // Agar Render par memory issue se browser crash ho, toh reference reset karein
        browser.on('disconnected', () => {
            console.log('Chromium browser disconnected/killed, resetting reference.');
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

async function downloadImage(url, destPath) {
    if (!url) return false;
    try {
        const writer = fs.createWriteStream(destPath);
        const response = await axiosInstance({ url, method: 'GET', responseType: 'stream' });
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(true));
            writer.on('error', (err) => {
                writer.close();
                reject(err);
            });
        });
    } catch (err) {
        return false;
    }
}

// MUI Selects ke exact IDs ke liye solid helper
async function selectMuiDropdown(page, selectId, targetText, allowPartial = true) {
    if (!targetText) return false;
    const clean = str => (str || '').replace(/\u200B/g, '').trim().toLowerCase();
    const search = clean(targetText);

    try {
        const selectTrigger = page.locator(`#${selectId}`);
        await selectTrigger.waitFor({ state: 'visible', timeout: 8000 });

        // Disabled state check (State select hone ke baad District enable hone ka wait)
        for (let i = 0; i < 20; i++) {
            const isDisabled = await selectTrigger.evaluate(el => el.classList.contains('Mui-disabled') || el.closest('.Mui-disabled') !== null);
            if (!isDisabled) break;
            await page.waitForTimeout(300);
        }

        await selectTrigger.click();
        await page.waitForTimeout(300);

        const listbox = page.locator('ul[role="listbox"]');
        await listbox.waitFor({ state: 'visible', timeout: 6000 });

        const options = page.locator('li[role="option"]');
        const count = await options.count();
        let targetOption = null;

        for (let i = 0; i < count; i++) {
            const opt = options.nth(i);
            const text = clean(await opt.innerText());
            if (text === search) {
                targetOption = opt;
                break;
            }
        }

        if (!targetOption && allowPartial) {
            for (let i = 0; i < count; i++) {
                const opt = options.nth(i);
                const text = clean(await opt.innerText());
                if (text.includes(search) || search.includes(text)) {
                    targetOption = opt;
                    break;
                }
            }
        }

        if (targetOption) {
            await targetOption.scrollIntoViewIfNeeded();
            await targetOption.click();
            await page.waitForTimeout(300);
            return true;
        } else {
            console.log(`Option "${targetText}" not found in #${selectId}`);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(200);
            return false;
        }
    } catch (e) {
        console.error(`Dropdown error on #${selectId}:`, e.message);
        await page.keyboard.press('Escape').catch(() => null);
        return false;
    }
}

async function doLoginOnPage(page, sso_id, password) {
    console.log('Session expire mila. Automatic re-login shuru kar rahe hain...');

    // Top Login button par click karein agar homepage par hain
    const topLoginBtn = page.locator('button:has-text("Login"), button.login-btn').first();
    if (await topLoginBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
        await topLoginBtn.click();
    }

    const ssoInput = page.locator('input[placeholder="Enter SSO ID"]');
    await ssoInput.waitFor({ timeout: 10000 });

    // Captcha read karein
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
        throw new Error('Auto re-login ke time CAPTCHA DOM me nahi mila.');
    }

    await ssoInput.fill(sso_id);
    await page.locator('input[placeholder="Enter Password"]').fill(password);
    await page.locator('input[placeholder="Enter Captcha"]').fill(captchaCode);

    await page.locator('button:has-text("Submit")').click();

    // Login card gayab hone ka wait karein
    await page.waitForFunction(() => !document.querySelector('.login-card'), { timeout: 12000 }).catch(() => null);
    await page.waitForTimeout(2000);
    console.log('Automatic re-login safal raha!');
}

async function sendCallback(callbackUrl, payload) {
    if (!callbackUrl) return false;
    try {
        await axiosInstance.post(callbackUrl, payload, { timeout: 15000 });
        return true;
    } catch (error) {
        console.error('Callback error:', error.message);
        return false;
    }
}

// ---------------- LOGIN ENDPOINT ----------------
app.post('/login-evisitor', async (req, res) => {
    const { url, sso_id, password } = req.body;
    const loginBaseUrl = url || 'https://evisitor.rajasthan.gov.in/evisitor';
    let context = null;

    try {
        const browser = await getBrowser();
        context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();

        // CSS/Media block for speed
        await page.route('**/*', (route) => {
            const resource = route.request().resourceType();
            if (['image', 'font', 'media', 'stylesheet'].includes(resource)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        await page.goto(loginBaseUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

        const topLoginBtn = page.locator('button.login-btn');
        if (await topLoginBtn.count() > 0) {
            await topLoginBtn.click();
        }

        const ssoInput = page.locator('input[placeholder="Enter SSO ID"]');
        await ssoInput.waitFor({ timeout: 10000 });

        // Captcha Extraction
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
            throw new Error('CAPTCHA DOM se read nahi ho paya.');
        }

        await ssoInput.fill(sso_id);
        await page.locator('input[placeholder="Enter Password"]').fill(password);
        await page.locator('input[placeholder="Enter Captcha"]').fill(captchaCode);

        await page.locator('button:has-text("Submit")').click();

        // Wait for login toast or card dismissal
        const toast = page.locator('.Toastify__toast');
        let toastText = '';
        try {
            await toast.waitFor({ timeout: 4000 });
            toastText = (await toast.innerText()).trim();
        } catch (e) {}

        await page.waitForFunction(() => !document.querySelector('.login-card'), { timeout: 10000 }).catch(() => null);

        // Session storage & cookies capture
        const cookies = await context.cookies();
        const storageData = await page.evaluate(() => {
            const loc = {};
            const ses = {};
            for (let i = 0; i < localStorage.length; i++) loc[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
            for (let i = 0; i < sessionStorage.length; i++) ses[sessionStorage.key(i)] = sessionStorage.getItem(sessionStorage.key(i));
            return { localStorage: loc, sessionStorage: ses };
        });

        await context.close();

        return res.json({
            status: 'success',
            toast_message: toastText || 'Login Successful',
            cookies: cookies,
            auth_storage: storageData
        });

    } catch (error) {
        if (context) await context.close();
        return res.status(500).json({ status: 'error', message: error.message });
    }
});

// ---------------- CREATE VISITOR LOGIC ----------------
async function processCreateVisitor(auth_storage, booking_data, sso_credentials) {
    const visitorsUrl = 'https://evisitor.rajasthan.gov.in/evisitor/user/visitors';
    let context = null;
    let page = null;
    let tempFiles = [];
    const updatedPersonIds = [];

    try {
        browser = await getBrowser();

        context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            timezoneId: 'Asia/Kolkata',
            serviceWorkers: 'block'
        });

        // 🚨 1. AUTO-KILLER: Jaise hi DOM me Update popup aaye, turant delete karein
        await context.addInitScript(() => {
            const observer = new MutationObserver(() => {
                const modals = document.querySelectorAll('.MuiDialog-root, .MuiModal-root');
                modals.forEach(m => {
                    if (m.innerText && m.innerText.includes('Update Available')) {
                        console.log('Update popup auto-killed from DOM');
                        m.remove();
                    }
                });
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        });

        // Storage un-nesting fix
        let storageData = auth_storage;
        if (storageData && storageData.auth_storage) {
            storageData = storageData.auth_storage;
        }

        if (storageData) {
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

        // Speed optimization: Drop media & fonts
        await page.route('**/*', (route) => {
            const resource = route.request().resourceType();
            if (['font', 'media', 'stylesheet'].includes(resource)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        await page.goto('https://evisitor.rajasthan.gov.in/evisitor', { waitUntil: 'commit' });
        
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
        await page.goto(visitorsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // 🚨 2. AUTO RE-LOGIN CHECK
        const isLoggedOut = page.url().includes('login') || 
                            !page.url().includes('/user/visitors') || 
                            (await page.locator('button:has-text("Login"), button.login-btn').first().isVisible({ timeout: 2500 }).catch(() => false));

        if (isLoggedOut) {
            console.log('Session expire mila. Re-login trigger kar rahe hain...');
            if (sso_credentials && sso_credentials.sso_id && sso_credentials.password) {
                await doLoginOnPage(page, sso_credentials.sso_id, sso_credentials.password);
                await page.goto(visitorsUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
            } else {
                throw new Error('Session expire ho gaya hai aur auto-login credentials nahi mile.');
            }
        }

        // 🚨 3. CLEAR ALL MODALS / BACKDROPS BEFORE CLICK
        await page.evaluate(() => {
            document.querySelectorAll('.MuiDialog-root, .MuiModal-root, .MuiBackdrop-root').forEach(m => {
                if (m.innerText && m.innerText.includes('Update Available')) {
                    m.remove();
                }
            });
        }).catch(() => null);

        await page.waitForTimeout(1000);

        // 🚨 4. FORCE CLICK CREATE VISITOR (No Timeout / No Backdrop Blocking)
        console.log('Clicking "CREATE VISITOR" button with FORCE & DOM fallback...');
        const createBtn = page.locator('button:has-text("CREATE VISITOR"), button:has-text("Create Visitor"), button:has-text("CHECK-IN")').first();
        await createBtn.waitFor({ state: 'attached', timeout: 15000 });

        // Direct DOM click + force click (kisi bhi overlay/backdrop ko bypass karega)
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const btn = buttons.find(b => {
                const txt = (b.textContent || '').trim().toUpperCase();
                return txt.includes('CREATE VISITOR') || txt.includes('CHECK-IN');
            });
            if (btn) btn.click();
        });

        // Agar DOM click trigger na hua ho toh Playwright force click karein
        await createBtn.click({ force: true, timeout: 5000 }).catch(() => null);

        await page.waitForSelector('input[name="roomNumber"]', { timeout: 15000 });
        console.log('Create Visitor Form successfully opened!');
        // 4. ROOM & BASE DETAILS FILLING
        console.log('Filling Room & Base Details...');
        if (booking_data.room_number) {
            await page.locator('input[name="roomNumber"]').fill(String(booking_data.room_number));
        }
        if (booking_data.check_in_date_time) {
            await page.locator('input[name="checkInDateTime"]').fill(booking_data.check_in_date_time);
        }
        if (booking_data.coming_from) {
            await page.locator('input[name="comingLocation"]').fill(booking_data.coming_from);
        }
        if (booking_data.going_to) {
            await page.locator('input[name="goingLocation"]').fill(booking_data.going_to);
        }
        if (booking_data.visit_reason) {
            await selectMuiDropdown(page, 'mui-component-select-visitReasonType', booking_data.visit_reason);
        }

        // 5. GUESTS LOOP
        const guests = booking_data.guests || [];
        console.log(`Processing ${guests.length} guest(s)...`);

        for (let i = 0; i < guests.length; i++) {
            const guest = guests[i];
            console.log(`Filling Guest ${i + 1}: ${guest.full_name || guest.name}`);

            // Text Inputs
            await page.locator('input[name="name"]').fill(guest.full_name || guest.name || '');
            if (guest.dateOfBirth) {
                await page.locator('input[name="dateOfBirth"]').fill(guest.dateOfBirth);
            }
            if (guest.mobile_number || guest.mobile) {
                await page.locator('input[name="mobileNumber"]').fill(String(guest.mobile_number || guest.mobile));
            }

            // MUI Dropdowns with exact HTML IDs
            const genderVal = (guest.gender || 'Male').toLowerCase() === 'female' ? 'Female' : 'Male';
            await selectMuiDropdown(page, 'mui-component-select-gender', genderVal);

            await selectMuiDropdown(page, 'mui-component-select-stateCd', guest.state || 'Rajasthan');
            
            // Wait for district options to load via backend API
            await page.waitForTimeout(600);
            await selectMuiDropdown(page, 'mui-component-select-districtcd', guest.district || 'Jaipur');

            // Document Type Dropdown
            const docType = guest.document_type || 'Aadhaar Card';
            await selectMuiDropdown(page, 'mui-component-select-documentType', docType);
            await page.waitForTimeout(400);

            // Document Number (Check if enabled)
            const docNumInput = page.locator('input[name="documentNumber"]');
            const isDocDisabled = await docNumInput.isDisabled();
            if (!isDocDisabled && guest.document_number) {
                await docNumInput.fill(String(guest.document_number));
            }

            // Address Textarea
            await page.locator('textarea[name="address"]').fill(guest.address || 'Rajasthan');

            // 6. DOCUMENT DOWNLOAD & 25KB AUTO-PADDING
            let rawDocUrls = [guest.document_url, guest.document_url_2].filter(Boolean);
            rawDocUrls = [...new Set(rawDocUrls)];
            const docUrls = rawDocUrls.map(u => (typeof u === 'string' && u.startsWith('/')) ? `${FIXED_BASE_URL}${u}` : u);

            const downloadedPaths = [];
            for (let dIdx = 0; dIdx < docUrls.length; dIdx++) {
                if (typeof docUrls[dIdx] === 'string' && docUrls[dIdx].startsWith('http')) {
                    const docPath = path.join('/tmp', `doc_${i}_${dIdx}_${Date.now()}.jpg`);
                    const ok = await downloadImage(docUrls[dIdx], docPath);
                    if (ok && fs.existsSync(docPath)) {
                        const stats = fs.statSync(docPath);
                        console.log(`Document downloaded: ${stats.size} bytes`);

                        // 🚨 25KB Rule Fix: Agar size 25.6KB se chhota hai, pad karein
                        if (stats.size < 26000) {
                            const padding = Buffer.alloc(26000 - stats.size, 0);
                            fs.appendFileSync(docPath, padding);
                            console.log(`Document padded to 26KB to satisfy portal limit.`);
                        }

                        downloadedPaths.push(docPath);
                        tempFiles.push(docPath);
                    }
                }
            }

            // File Upload via Playwright
            if (downloadedPaths.length > 0) {
                const fileInput = page.locator('input[type="file"]').first();
                await fileInput.waitFor({ state: 'attached', timeout: 5000 });
                await fileInput.setInputFiles(downloadedPaths[0]);
                console.log('Document attached, waiting for upload processing...');
                await page.waitForTimeout(2000);
            }

            // 7. CLICK 'Add' BUTTON
            console.log(`Clicking 'Add' button for Guest ${i + 1}...`);
            const addBtn = page.locator('button:has-text("Add")').first();
            await addBtn.click();

            // Wait for validation errors or successful list insertion
            await page.waitForTimeout(600);
            const errorHelper = page.locator('.Mui-error, .MuiFormHelperText-root.Mui-error');
            const errCount = await errorHelper.count();
            if (errCount > 0) {
                const errTexts = await errorHelper.allInnerTexts();
                const cleanErrors = [...new Set(errTexts.map(t => t.trim()).filter(Boolean))];
                if (cleanErrors.length > 0) {
                    throw new Error(`Guest ${i + 1} validation error: ${cleanErrors.join(' | ')}`);
                }
            }

            if (guest.person_pk) {
                updatedPersonIds.push(guest.person_pk);
            }
            console.log(`Guest ${i + 1} added to table successfully.`);
        }

        // 8. FINAL CHECK-IN SUBMIT
        console.log('Submitting Final Check-In...');
        const submitBtn = page.locator('button:has-text("Submit Check-In")').first();
        await submitBtn.click();

        let toastMessage = 'Visitor check-in submitted successfully.';
        try {
            const toast = page.locator('.Toastify__toast');
            await toast.waitFor({ timeout: 4000 });
            toastMessage = await toast.innerText();
        } catch (e) {}

        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
        await context.close();

        return { status: 'success', message: toastMessage, updated_person_ids: updatedPersonIds };

    } catch (error) {
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
        let errorScreenshotBase64 = null;
        if (page && !page.isClosed()) {
            try {
                const buffer = await page.screenshot({ fullPage: true });
                errorScreenshotBase64 = buffer.toString('base64');
            } catch (e) {}
        }
        if (context) await context.close();

        return {
            status: 'failed',
            message: error.message,
            error_screenshot: errorScreenshotBase64 ? `data:image/png;base64,${errorScreenshotBase64}` : null
        };
    }
}

// Helpers for robust MUI Combobox Selection
async function selectMuiCombobox(page, index, text) {
    try {
        const combo = page.locator('[role="combobox"]').nth(index);
        await combo.click();
        const option = page.locator('li[role="option"]', { hasText: new RegExp(text, 'i') }).first();
        await option.waitFor({ timeout: 2000 });
        await option.click();
    } catch (e) {
        await page.keyboard.press('Escape');
    }
}

async function selectMuiComboboxByKeyword(page, keyword, text) {
    try {
        const combo = page.locator(`[role="combobox"]`).filter({
            has: page.locator(`xpath=ancestor-or-self::*[contains(@class, "MuiFormControl") or contains(@name, "${keyword}") or contains(@id, "${keyword}")]`)
        }).first();

        if (await combo.count() > 0) {
            await combo.click();
        } else {
            await page.locator('[role="combobox"]').first().click();
        }

        const option = page.locator('li[role="option"]', { hasText: new RegExp(`^${text}$`, 'i') });
        if (await option.count() > 0) {
            await option.first().click();
        } else {
            const fallbackOption = page.locator('li[role="option"]', { hasText: new RegExp(text, 'i') }).first();
            await fallbackOption.waitFor({ timeout: 1500 });
            await fallbackOption.click();
        }
    } catch (e) {
        await page.keyboard.press('Escape');
    }
}

function startCreateVisitorBackground(auth_storage, booking_data, callback_url, sso_credentials) {
    setImmediate(async () => {
        try {
            const result = await processCreateVisitor(auth_storage, booking_data, sso_credentials);
            if (callback_url) {
                await sendCallback(callback_url, { ...result, timestamp: new Date().toISOString() });
            }
        } catch (error) {
            if (callback_url) {
                await sendCallback(callback_url, {
                    status: 'failed',
                    message: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });
}

// Background Task Execution
app.post('/create-visitor', (req, res) => {
    const { auth_storage, booking_data, callback_url, sso_credentials } = req.body;
    if (!booking_data || !booking_data.guests?.length) {
        return res.status(400).json({ status: 'failed', message: 'Valid booking_data required hai.' });
    }

    startCreateVisitorBackground(auth_storage, booking_data, callback_url, sso_credentials);
    
    return res.status(202).json({
        status: 'processing',
        message: 'Automation queued successfully.',
        callback_enabled: !!callback_url
    });
});

app.listen(PORT, () => console.log(`Playwright service running on port ${PORT}`));
