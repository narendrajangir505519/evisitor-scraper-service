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
            for (const text of texts) {
                const btn = page.getByRole('button', { name: text, exact: false }).first();
                if (await btn.isVisible({ timeout: 1200 }).catch(() => false)) {
                    await btn.scrollIntoViewIfNeeded();
                    await btn.click();
                    return true;
                }
            }

            if (fallbackIndex !== null) {
                console.warn(`${label}: text selector nahi mila, fallback button index ${fallbackIndex} use ho raha hai.`);
                const clicked = await page.evaluate((idx) => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const btn = buttons[idx];
                    if (!btn) return false;
                    btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                    btn.click();
                    return true;
                }, fallbackIndex);
                if (clicked) return true;
            }

            throw new Error(`${label} button DOM me nahi mila.`);
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
                return String(value || '').trim().toLowerCase() === 'voter id number';
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
        await clickButtonSmart({
            texts: [/submit check-?in/i, /^submit$/i],
            fallbackIndex: 6,
            label: 'Submit Check-In'
        });

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
