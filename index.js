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
        const browser = await getBrowser();

        context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            timezoneId: 'Asia/Kolkata',
            serviceWorkers: 'block'
        });

        page = await context.newPage();

        // Asset aborting (CSS, images, fonts)
        await page.route('**/*', (route) => {
            const resource = route.request().resourceType();
            if (['font', 'media', 'stylesheet'].includes(resource)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        // Initialize domain and set storage
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
        await page.goto(visitorsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // 1. AUTO RE-LOGIN CHECK (Agar session expire hokar logout ho gaya ho)
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

        // 2. "Update Available" CHECK & CLICK
        try {
            const updateBtn = page.locator('button:has-text("Update Now"), button:has-text("UPDATE NOW")').first();
            if (await updateBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                console.log('"Update Available" popup mila! "Update Now" click kar rahe hain...');
                await updateBtn.click();
                await page.waitForTimeout(2500);
            }
        } catch (e) {}

        // Clear any backdrop/dialog if left
        await page.evaluate(() => {
            document.querySelectorAll('.MuiDialog-root, .MuiModal-root').forEach(m => {
                if (m.innerText && m.innerText.includes('Update Available')) m.remove();
            });
        }).catch(() => null);

        await page.waitForTimeout(1000);

        // 3. "CREATE VISITOR" BUTTON CLICK
        console.log('Finding and clicking "CREATE VISITOR" button...');
        const createBtnClicked = await page.evaluate(() => {
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
            throw new Error('Create Visitor / Check-In button nahi mila.');
        }

        await page.waitForSelector('input[name="checkInDateTime"], input[name="roomNumber"]', { timeout: 15000 });

        // 4. BOOKING BASE LEVEL DETAILS FILLING (Puppeteer Working Logic)
        console.log('Filling Booking Level Details...');
        const baseResult = await page.evaluate(async (bData) => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            const norm = v => String(v || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

            function fireReactInput(el, value) {
                if (!el) return false;
                try { el.removeAttribute('disabled'); } catch (e) {}
                const v = value ?? '';
                const isTa = el.tagName === 'TEXTAREA';
                const setter = Object.getOwnPropertyDescriptor((isTa ? HTMLTextAreaElement : HTMLInputElement).prototype, 'value')?.set;
                try {
                    if (setter) setter.call(el, v);
                    else el.value = v;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                    return true;
                } catch (e) { return false; }
            }

            function setInputByName(name, value) {
                if (value === undefined || value === null || value === '') return false;
                const el = document.querySelector(`[name="${name}"]`);
                return el ? fireReactInput(el, value) : false;
            }

            async function selectComboByIndex(index, optionText) {
                if (!optionText) return false;
                const combos = Array.from(document.querySelectorAll('[role="combobox"]'));
                const combo = combos[index] || combos[combos.length - 1];
                if (!combo) return false;

                combo.scrollIntoView({ behavior: 'instant', block: 'center' });
                await sleep(300);
                combo.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                combo.click();

                let options = [];
                const need = norm(optionText);

                for (let attempt = 0; attempt < 10; attempt++) {
                    await sleep(50);
                    options = Array.from(document.querySelectorAll('li[role="option"]')).filter(o => {
                        const rect = o.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0 && (o.innerText || o.textContent || '').trim() !== '';
                    });
                    if (options.length > 0) break;
                }

                if (options.length === 0) {
                    document.body.click();
                    await sleep(300);
                    return false;
                }

                const option = options.find(o => {
                    const text = norm(o.innerText || o.textContent);
                    return text === need || text.includes(need);
                });

                if (!option) {
                    document.body.click();
                    await sleep(50);
                    return false;
                }

                option.scrollIntoView({ behavior: 'instant', block: 'center' });
                await sleep(30);
                option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                option.click();
                await sleep(80);
                return true;
            }

            if (bData.check_in_date_time) setInputByName('checkInDateTime', bData.check_in_date_time);
            if (bData.room_number) setInputByName('roomNumber', bData.room_number);
            if (bData.coming_from) setInputByName('comingLocation', bData.coming_from);
            if (bData.going_to) setInputByName('goingLocation', bData.going_to);

            if (bData.visit_reason) {
                await selectComboByIndex(0, bData.visit_reason);
            }

            return { success: true };
        }, booking_data);

        if (!baseResult.success) {
            throw new Error('Booking base level fields fill nahi ho sake.');
        }

        // 5. GUESTS FILLING LOOP (Puppeteer Working Logic)
        const guests = booking_data.guests || [];
        console.log(`Processing ${guests.length} guest(s)...`);

        for (let i = 0; i < guests.length; i++) {
            const guest = guests[i];
            console.log(`Filling Guest ${i + 1}: ${guest.full_name || guest.name || 'Guest'}`);

            const guestFillResult = await page.evaluate(async (g) => {
                const sleep = ms => new Promise(r => setTimeout(r, ms));
                const norm = v => String(v || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

                function fireReactInput(el, value) {
                    if (!el) return false;
                    try { el.removeAttribute('disabled'); } catch (e) {}
                    const v = value ?? '';
                    const isTa = el.tagName === 'TEXTAREA';
                    const setter = Object.getOwnPropertyDescriptor((isTa ? HTMLTextAreaElement : HTMLInputElement).prototype, 'value')?.set;
                    try {
                        if (setter) setter.call(el, v);
                        else el.value = v;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                        return true;
                    } catch (e) { return false; }
                }

                function setInputByName(name, value) {
                    if (value === undefined || value === null || value === '') return false;
                    const el = document.querySelector(`[name="${name}"]`);
                    return el ? fireReactInput(el, value) : false;
                }

                function setDocumentNumber(value) {
                    if (!value) return false;
                    const selectors = [
                        'input[name="documentNumber"]',
                        'input[placeholder*="document number" i]',
                        'input[placeholder*="Document Number" i]',
                        'input[placeholder*="document" i]',
                        'input[name="idNumber"]',
                        'input[name="docNumber"]'
                    ];
                    for (const selector of selectors) {
                        const el = document.querySelector(selector);
                        if (el) return fireReactInput(el, value);
                    }
                    return false;
                }

                function getGender(v) {
                    const x = norm(v);
                    if (x === 'female' || x === 'f') return 'Female';
                    if (x === 'male' || x === 'm') return 'Male';
                    if (x === 'other' || x === 'o') return 'Other';
                    return v || '';
                }

                async function selectComboByTarget(targetKeyword, fallbackIndex, optionText, useSecondOptionFallback = false) {
                    if (!optionText) return false;
                    const combos = Array.from(document.querySelectorAll('[role="combobox"]'));
                    let combo = null;
                    if (targetKeyword) {
                        const kw = norm(targetKeyword);
                        combo = combos.find(c => {
                            const parent = c.closest('.MuiFormControl-root, .form-group, div') || c.parentElement;
                            const text = norm(parent ? parent.innerText || parent.textContent : '');
                            const placeholder = norm(c.getAttribute('placeholder') || '');
                            const ariaLabel = norm(c.getAttribute('aria-label') || '');
                            const id = norm(c.id || '');
                            const name = norm(c.getAttribute('name') || '');
                            return text.includes(kw) || placeholder.includes(kw) || ariaLabel.includes(kw) || id.includes(kw) || name.includes(kw);
                        });
                    }

                    if (!combo && fallbackIndex !== undefined) {
                        combo = combos[fallbackIndex] || combos[combos.length - 1];
                    }

                    if (!combo) return false;

                    for (let attempt = 0; attempt < 20; attempt++) { 
                        const isMuiDisabled = combo.classList.contains('Mui-disabled') || (combo.closest('.Mui-disabled') !== null);
                        const isDisabled = combo.hasAttribute('disabled') || combo.getAttribute('aria-disabled') === 'true';
                        if (!isDisabled && !isMuiDisabled) break;
                        await sleep(300);
                    }

                    combo.scrollIntoView({ behavior: 'instant', block: 'center' });
                    await sleep(60);
                    const need = norm(optionText);

                    if (combo.tagName === 'INPUT') {
                        combo.focus();
                        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                        if (setter) setter.call(combo, ''); else combo.value = '';
                        combo.dispatchEvent(new Event('input', { bubbles: true }));
                        await sleep(200);

                        if (optionText.length > 2) {
                            const typeText = optionText.substring(0, 4);
                            if (setter) setter.call(combo, typeText); else combo.value = typeText;
                            combo.dispatchEvent(new Event('input', { bubbles: true }));
                            await sleep(80); 
                        }
                    }

                    combo.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                    combo.click();

                    let option = null;
                    for (let attempt = 0; attempt < 25; attempt++) { 
                        await sleep(300);
                        const options = Array.from(document.querySelectorAll('li[role="option"]')).filter(o => {
                            const rect = o.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0;
                        });

                        option = options.find(o => {
                            const text = norm(o.innerText || o.textContent);
                            return text === need || text.startsWith(need + ' ') || text.endsWith(' ' + need) || text.includes(' ' + need + ' ');
                        });

                        if (!option) {
                            option = options.find(o => norm(o.innerText || o.textContent).includes(need));
                        }

                        if (option) break; 
                        if (attempt === 8 || attempt === 16) combo.click();
                    }

                    if (option) {
                        option.scrollIntoView({ behavior: 'instant', block: 'center' });
                        await sleep(30);
                        option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                        option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                        option.click();
                        await sleep(60);
                    } else if (useSecondOptionFallback) {
                        const visibleOptions = Array.from(document.querySelectorAll('li[role="option"]')).filter(o => {
                            const rect = o.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0;
                        });
                        if (visibleOptions.length >= 2) {
                            visibleOptions[1].click();
                            await sleep(30);
                        }
                    }

                    document.dispatchEvent(new KeyboardEvent('keydown', {
                        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
                    }));
                    await sleep(50);
                    document.body.click();

                    for (let i = 0; i < 10; i++) {
                        if (!document.querySelector('ul[role="listbox"]')) break;
                        await sleep(30);
                    }

                    return !!option;
                }

                setInputByName('name', g.full_name || g.name || g.guest_name);
                setInputByName('mobileNumber', g.mobile_number || g.mobile);
                setInputByName('address', g.address);
                setInputByName('dateOfBirth', g.dateOfBirth);

                if (g.gender) {
                    await selectComboByTarget('gender', 1, getGender(g.gender));
                }

                if (g.state || g.stateCd) {
                    await selectComboByTarget('stateCd', 3, g.state || g.stateCd, true);
                }

                if (g.district || g.districtcd) {
                    await selectComboByTarget('districtcd', 4, g.district || g.districtcd, true);
                }

                const docType = g.document_type || g.documentType || g.id_type || g.type || '';
                if (docType) {
                    let success = await selectComboByTarget('document', 6, docType);
                    if (!success) {
                        await selectComboByTarget('type', 5, docType);
                    }
                }

                const isAadhaar = norm(docType).includes('aadhaar') || norm(docType).includes('aadhar');
                if (!isAadhaar) {
                    const docNum = g.document_number || g.documentNumber || g.id_number || g.doc_number;
                    if (docNum) {
                        setDocumentNumber(docNum);
                        await sleep(80);
                    }
                }

                return { success: true };
            }, guest);

            if (!guestFillResult.success) {
                throw new Error(`Guest ${i + 1} ki details set nahi ho payi.`);
            }

            // 6. DOCUMENT DOWNLOAD & UPLOAD (Single File Upload Safe)
            let rawDocUrls = [guest.document_url, guest.document_url_2].filter(Boolean);
            rawDocUrls = [...new Set(rawDocUrls)];

            const docUrls = rawDocUrls.map(u => (typeof u === 'string' && u.startsWith('/')) ? `${FIXED_BASE_URL}${u}` : u);

            const downloadedPaths = [];
            for (let dIdx = 0; dIdx < docUrls.length; dIdx++) {
                if (typeof docUrls[dIdx] === 'string' && docUrls[dIdx].startsWith('http')) {
                    const docPath = path.join('/tmp', `g_${i}_d_${dIdx}_${Date.now()}.jpg`);
                    const ok = await downloadImage(docUrls[dIdx], docPath);
                    if (ok && fs.existsSync(docPath)) {
                        downloadedPaths.push(docPath);
                        tempFiles.push(docPath);
                    }
                }
            }

            if (downloadedPaths.length > 0) {
                await page.waitForSelector('input[type="file"]', { timeout: 5000 }).catch(() => null);
                const fileInputs = await page.$$('input[type="file"]');
                if (fileInputs.length > 0) {
                    // Portal input non-multiple hai isliye single file pass karenge
                    await fileInputs[0].setInputFiles(downloadedPaths[0]);
                    await page.evaluate((el) => {
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                    }, fileInputs[0]);
                    await page.waitForTimeout(1000);
                }
            }

            // 7. CLICK 'ADD' BUTTON & VERIFY (Puppeteer Working Logic)
            console.log(`Clicking 'Add' button for Guest ${i + 1}...`);
            const addResult = await page.evaluate(async () => {
                const sleep = ms => new Promise(r => setTimeout(r, ms));
                const buttons = Array.from(document.querySelectorAll('button'));
                const addBtn = buttons.find(b => b.textContent.trim() === 'Add');
                if (!addBtn) return { success: false, error: '"Add" button nahi mila.' };

                addBtn.click();

                for (let x = 0; x < 15; x++) {
                    await sleep(100);
                    const errors = Array.from(document.querySelectorAll('.Mui-error, .MuiFormHelperText-root.Mui-error'))
                        .map(e => e.innerText.trim())
                        .filter(Boolean);

                    if (errors.length) {
                        return {
                            success: false,
                            error: 'Input Error: ' + [...new Set(errors)].join(' | ')
                        };
                    }
                }

                const errors = Array.from(document.querySelectorAll('.Mui-error, .MuiFormHelperText-root.Mui-error'))
                    .map(e => e.innerText.trim())
                    .filter(t => t.length > 0);

                if (errors.length > 0) {
                    return { success: false, error: 'Input Error: ' + [...new Set(errors)].join(' | ') };
                }
                return { success: true };
            });

            if (!addResult.success) {
                throw new Error(`Guest ${i + 1} (${guest.full_name || 'Guest'}) Add nahi ho paya: ${addResult.error}`);
            }

            if (guest.person_pk !== undefined && guest.person_pk !== null) {
                updatedPersonIds.push(guest.person_pk);
            }
        }

        // 8. FINAL CHECK-IN SUBMISSION
        console.log('Submitting Final Check-In...');
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const submitBtn = buttons.find(b => {
                const txt = b.textContent.trim();
                return txt.includes('Submit Check-In') || txt === 'Submit';
            });
            if (submitBtn) submitBtn.click();
        });

        let toastMessage = 'Visitor check-in submitted successfully.';
        try {
            const toast = page.locator('.Toastify__toast');
            await toast.waitFor({ timeout: 2500 });
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
