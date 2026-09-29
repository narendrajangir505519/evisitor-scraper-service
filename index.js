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
async function processCreateVisitor(auth_storage, booking_data) {
    const visitorsUrl = 'https://evisitor.rajasthan.gov.in/evisitor/user/visitors';
    let context = null;
    let page = null;
    const tempFiles = [];
    const updatedPersonIds = [];

    try {
        browser = await getBrowser();

        // 1. serviceWorkers: 'block' taaki popup check hi na ho
        context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            timezoneId: 'Asia/Kolkata',
            serviceWorkers: 'block'
        });

        page = await context.newPage();

        // 2. DOM Auto-Killer: Agar popup DOM me inject ho, turant delete kar de
        await page.addInitScript(() => {
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

        // Speed optimization: Unnecessary assets drop karein
        await page.route('**/*', (route) => {
            const resource = route.request().resourceType();
            if (['font', 'media', 'stylesheet'].includes(resource)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        // Domain initialize aur storage inject karein
        await page.goto('https://evisitor.rajasthan.gov.in/evisitor', { waitUntil: 'commit' });
        if (auth_storage) {
            await page.evaluate((storage) => {
                if (storage.localStorage) {
                    Object.keys(storage.localStorage).forEach(k => localStorage.setItem(k, storage.localStorage[k]));
                }
                if (storage.sessionStorage) {
                    Object.keys(storage.sessionStorage).forEach(k => sessionStorage.setItem(k, storage.sessionStorage[k]));
                }
            }, auth_storage);
        }

        console.log('Navigating to Visitors Page...');
        await page.goto(visitorsUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

        if (page.url().includes('login') || !page.url().includes('/user/visitors')) {
            throw new Error('Session expire ho gaya hai ya invalid auth data hai.');
        }

        await page.waitForTimeout(1500);

        // 3. Direct DOM Click: Bina kisi pointer lock ya overlay block ke seedha click
        console.log('Clicking CREATE VISITOR button via direct DOM...');
        const createBtnClicked = await page.evaluate(() => {
            document.querySelectorAll('.MuiDialog-root, .MuiModal-root').forEach(m => {
                if (m.innerText && m.innerText.includes('Update Available')) m.remove();
            });

            const buttons = Array.from(document.querySelectorAll('button'));
            const targetBtn = buttons.find(b => {
                const txt = (b.textContent || '').trim().toUpperCase();
                return txt.includes('CREATE VISITOR') || txt.includes('CHECK-IN');
            });

            if (targetBtn) {
                targetBtn.click();
                return true;
            }
            return false;
        });

        if (!createBtnClicked) {
            throw new Error('Create Visitor / Check-In button DOM me nahi mila.');
        }

        // Form fields render hone ka wait karein
        await page.waitForSelector('input[name="checkInDateTime"], input[name="roomNumber"]', { timeout: 15000 });

        // 1. Fill Booking Base Level Fields
        await page.evaluate(async (bData) => {
            const norm = v => String(v || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            const setVal = (selector, val) => {
                const el = document.querySelector(selector);
                if (!el || val === undefined || val === null) return;
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                if (setter) setter.call(el, val); else el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            };

            if (bData.check_in_date_time) setVal('input[name="checkInDateTime"]', bData.check_in_date_time);
            if (bData.room_number) setVal('input[name="roomNumber"]', bData.room_number);
            if (bData.coming_from) setVal('input[name="comingLocation"]', bData.coming_from);
            if (bData.going_to) setVal('input[name="goingLocation"]', bData.going_to);
        }, booking_data);

        // Select visit reason combobox
        if (booking_data.visit_reason) {
            await selectMuiCombobox(page, 0, booking_data.visit_reason);
        }

        // 2. Loop Through Guests
        const guests = booking_data.guests || [];
        for (let i = 0; i < guests.length; i++) {
            const guest = guests[i];

            await page.evaluate(async (g) => {
                const setVal = (selector, val) => {
                    const el = document.querySelector(selector);
                    if (!el || val === undefined || val === null) return;
                    const isTa = el.tagName === 'TEXTAREA';
                    const proto = isTa ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                    if (setter) setter.call(el, val); else el.value = val;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                };

                setVal('input[name="name"]', g.full_name || g.name);
                setVal('input[name="mobileNumber"]', g.mobile_number || g.mobile);
                setVal('input[name="address"]', g.address);
                setVal('input[name="dateOfBirth"]', g.dateOfBirth);

                const docType = (g.document_type || '').toLowerCase();
                const isAadhaar = docType.includes('aadhaar') || docType.includes('aadhar');
                if (!isAadhaar) {
                    const docNum = g.document_number || '';
                    if (docNum) setVal('input[name="documentNumber"], input[placeholder*="document number" i]', docNum);
                }
            }, guest);

            // Material-UI Selects for Guest
            if (guest.gender) {
                await selectMuiComboboxByKeyword(page, 'gender', guest.gender);
            }
            if (guest.state) {
                await selectMuiComboboxByKeyword(page, 'stateCd', guest.state);
            }
            if (guest.district) {
                await selectMuiComboboxByKeyword(page, 'districtcd', guest.district);
            }
            if (guest.document_type) {
                await selectMuiComboboxByKeyword(page, 'document', guest.document_type);
            }

            // Documents Download & Upload via Playwright setInputFiles
            let docUrls = [guest.document_url, guest.document_url_2].filter(Boolean);
            docUrls = [...new Set(docUrls)].map(u => (typeof u === 'string' && u.startsWith('/')) ? `${FIXED_BASE_URL}${u}` : u);

            const downloadedPaths = [];
            for (let dIdx = 0; dIdx < docUrls.length; dIdx++) {
                const docPath = path.join('/tmp', `g_${i}_d_${dIdx}_${Date.now()}.jpg`);
                const ok = await downloadImage(docUrls[dIdx], docPath);
                if (ok && fs.existsSync(docPath)) {
                    downloadedPaths.push(docPath);
                    tempFiles.push(docPath);
                }
            }

            if (downloadedPaths.length > 0) {
                const fileInputs = page.locator('input[type="file"]');
                const count = await fileInputs.count();
                if (count > 0) {
                    if (count >= downloadedPaths.length && count > 1) {
                        for (let fIdx = 0; fIdx < downloadedPaths.length; fIdx++) {
                            await fileInputs.nth(fIdx).setInputFiles(downloadedPaths[fIdx]);
                        }
                    } else {
                        await fileInputs.first().setInputFiles(downloadedPaths);
                    }
                }
            }

            // Click Add Guest Button
            const addBtn = page.locator('button:has-text("Add")').first();
            await addBtn.click();

            // Wait for validation error check
            await page.waitForTimeout(400);
            const errCount = await page.locator('.Mui-error').count();
            if (errCount > 0) {
                const errText = await page.locator('.Mui-error').allInnerTexts();
                throw new Error(`Guest ${i + 1} validation error: ${[...new Set(errText)].join(' | ')}`);
            }

            if (guest.person_pk) {
                updatedPersonIds.push(guest.person_pk);
            }
        }

        // Final Form Submission
        const submitBtn = page.locator('button:has-text("Submit Check-In"), button:has-text("Submit")').first();
        await submitBtn.click();

        let toastMsg = 'Visitor check-in submitted successfully.';
        try {
            const toast = page.locator('.Toastify__toast');
            await toast.waitFor({ timeout: 3000 });
            toastMsg = await toast.innerText();
        } catch (e) {}

        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
        await context.close();

        return { status: 'success', message: toastMsg, updated_person_ids: updatedPersonIds };

    } catch (error) {
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
        
        let errorScreenshotBase64 = null;
        if (page && !page.isClosed()) {
            try {
                const buffer = await page.screenshot({ fullPage: true });
                errorScreenshotBase64 = buffer.toString('base64');
            } catch (e) {}
        }
    
        // Context close karein, sharedBrowser ko zinda rehne dein
        if (context) {
            try { await context.close(); } catch (e) {}
        }
    
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

// Background Task Execution
app.post('/create-visitor', (req, res) => {
    const { auth_storage, booking_data, callback_url } = req.body;
    if (!booking_data || !booking_data.guests?.length) {
        return res.status(400).json({ status: 'failed', message: 'Valid booking_data required hai.' });
    }

    setImmediate(async () => {
        try {
            const result = await processCreateVisitor(auth_storage, booking_data);
            if (callback_url) {
                await sendCallback(callback_url, {
                    ...result,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (err) {
            if (callback_url) {
                await sendCallback(callback_url, {
                    status: 'failed',
                    message: err.message,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });

    return res.status(202).json({
        status: 'processing',
        message: 'Automation queued successfully.',
        callback_enabled: !!callback_url
    });
});

app.listen(PORT, () => console.log(`Playwright service running on port ${PORT}`));
