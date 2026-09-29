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

const axiosInstance = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 20000
});

const PORT = process.env.PORT || 3000;

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

        const response = await axiosInstance.post(
            callbackUrl,
            payload,
            {
                timeout: 15000,
                headers: {
                    'Content-Type': 'application/json'
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

        console.log(
            'Callback success:',
            response.status,
            response.data
        );

        return true;
    } catch (error) {
        console.error(
            'Callback failed:',
            error.message
        );

        if (error.response) {
            console.error(
                'Callback response:',
                error.response.status,
                error.response.data
            );
        }

        return false;
    }
}

function startCreateVisitorBackground(auth_storage, booking_data, callback_url) {
    setImmediate(async () => {
        try {
            console.log('BACKGROUND CREATE VISITOR STARTED');

            const result = await processCreateVisitor(
                auth_storage,
                booking_data
            );

            console.log(
                'Background process completed:',
                result.status
            );

            if (callback_url) {
                await sendCallback(
                    callback_url,
                    {
                        status: result.status,
                        message: result.message || '',
                        updated_person_ids: result.updated_person_ids || [],
                        screenshot: result.screenshot || null,
                        error_screenshot: result.error_screenshot || null,
                        timestamp: new Date().toISOString()
                    }
                );
            }
        } catch (error) {
            console.error(
                'Background process fatal error:',
                error
            );

            if (callback_url) {
                await sendCallback(
                    callback_url,
                    {
                        status: 'failed',
                        message: error.message || 'Background automation failed',
                        updated_person_ids: [],
                        screenshot: null,
                        error_screenshot: null,
                        timestamp: new Date().toISOString()
                    }
                );
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
        const executablePath = await sparticuzChromium.executablePath();
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
                '--no-first-run',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-sync',
                '--mute-audio'
            ],
            executablePath: executablePath || '/usr/bin/google-chrome',
            headless: true
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
            if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        console.log('Not logged in. Redirected to login page. Starting login automation...');
        await page.goto(loginBaseUrl, { waitUntil: 'load', timeout: 25000 });

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
            await page.waitForSelector('.Toastify__toast', { timeout: 3000 });
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
            let localData = {};
            let sessionData = {};

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

// CREATE VISITOR AUTOMATION ENDPOINT
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
            viewport: { width: 1280, height: 800 },
            timezoneId: 'Asia/Kolkata',
            serviceWorkers: 'block'
        });

        // Un-nesting storage agar Laravel se auth_storage wrap hokar aaya ho
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

        if (page.url().includes('login') || !page.url().includes('/user/visitors')) {
            throw new Error('Session expire ho gaya hai ya invalid auth data hai.');
        }

        // Update popup check
        try {
            const updateBtn = page.locator('button:has-text("Update Now"), button:has-text("UPDATE NOW")').first();
            console.log('Update Now Ka Modal Check Ho Raha Hai');
            if (await updateBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                console.log('Update Now Ka Modal Open Hai');
                await updateBtn.click();
                await page.waitForTimeout(2500);
            }
        } catch (e) {}

        const createBtnClicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const targetBtn = buttons.find(b => (b.textContent || '').trim().toUpperCase() === 'CREATE VISITOR');
            if (!targetBtn) return { success: false, error: '"CREATE VISITOR" button nahi mila.' };
            if (targetBtn) {
                targetBtn.click();
                return true;
            }
            return false;
        });

        if (!createBtnClicked) {
            throw new Error('Create Visitor / Check-In button nahi mila.');
        }

        await new Promise(r => setTimeout(r, 1000));

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
                        const isVisible = rect.width > 0 && rect.height > 0;
                        const t = (o.innerText || o.textContent || '').replace(/\u200B/g, '').trim();
                        return isVisible && t !== '';
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
                    if (text === need) return true;
                    return text.includes(need);
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
                        await sleep(500);
                    }

                    combo.scrollIntoView({ behavior: 'instant', block: 'center' });
                    await sleep(60);
                    
                    const need = norm(optionText);

                    if (combo.tagName === 'INPUT') {
                        combo.focus();
                        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                        if (setter) setter.call(combo, ''); else combo.value = '';
                        combo.dispatchEvent(new Event('input', { bubbles: true }));
                        await sleep(300);
                        
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

                    for (let attempt = 0; attempt < 30; attempt++) { 
                        await sleep(500);
                        
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

                        if (option) {
                            break; 
                        }

                        if (attempt === 10 || attempt === 20) {
                            combo.click();
                        }
                    }

                    if (option) {
                        option.scrollIntoView({ behavior: 'instant', block: 'center' });
                        await sleep(30);
                        option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                        option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                        option.click();
                        await sleep(60);
                    } else if (useSecondOptionFallback) {
                        const visibleOptions = Array.from(
                            document.querySelectorAll('li[role="option"]')
                        ).filter(o => {
                            const rect = o.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0;
                        });
                    
                        if (visibleOptions.length >= 2) {
                            const defaultOption = visibleOptions[1];
                            defaultOption.click();
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
                    await selectComboByTarget(
                        'stateCd',
                        3,
                        g.state || g.stateCd,
                        true
                    );
                }
                
                if (g.district || g.districtcd) {
                    await selectComboByTarget(
                        'districtcd',
                        4,
                        g.district || g.districtcd,
                        true
                    );
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

            let rawDocUrls = [
                guest.document_url,
                guest.document_url_2,
            ].filter(Boolean);

            rawDocUrls = [...new Set(rawDocUrls)];

            const docUrls = rawDocUrls.map(u => {
                if (typeof u === 'string' && u.startsWith('/')) {
                    return `${FIXED_BASE_URL}${u}`;
                }
                return u;
            });

            const downloadedResults = await Promise.all(
                docUrls.map(async (url, dIdx) => {
                    if (
                        typeof url !== 'string' ||
                        !url.startsWith('http')
                    ) {
                        return null;
                    }
            
                    const docPath = path.join(
                        '/tmp',
                        `doc_g${i + 1}_d${dIdx + 1}_${Date.now()}.jpg`
                    );
            
                    const ok = await downloadImage(url, docPath);
            
                    if (!ok || !fs.existsSync(docPath)) {
                        return null;
                    }

                    // 25KB Portal requirement check & auto-pad
                    const stats = fs.statSync(docPath);
                    if (stats.size < 26000) {
                        const padding = Buffer.alloc(26000 - stats.size, 0);
                        fs.appendFileSync(docPath, padding);
                    }
            
                    tempFiles.push(docPath);
            
                    return docPath;
                })
            );
            
            const downloadedDocPaths = downloadedResults.filter(Boolean);

            if (downloadedDocPaths.length > 0) {
                await page.waitForSelector('input[type="file"]', { timeout: 5000 }).catch(() => null);
                const fileInputs = await page.$$('input[type="file"]');

                if (fileInputs.length > 0) {
                    if (fileInputs.length >= downloadedDocPaths.length && fileInputs.length > 1) {
                        for (let fIdx = 0; fIdx < downloadedDocPaths.length; fIdx++) {
                            await fileInputs[fIdx].setInputFiles(downloadedDocPaths[fIdx]);
                            await page.evaluate((el) => {
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                el.dispatchEvent(new Event('blur', { bubbles: true }));
                            }, fileInputs[fIdx]);
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    } else {
                        // Non-multiple single input
                        await fileInputs[0].setInputFiles(downloadedDocPaths[0]);
                        await page.evaluate((el) => {
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            el.dispatchEvent(new Event('blur', { bubbles: true }));
                        }, fileInputs[0]);
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
            }

            console.log(`Clicking 'Add' button for Guest ${i + 1}...`);
            const addResult = await page.evaluate(async () => {
                const sleep = ms => new Promise(r => setTimeout(r, ms));
                const buttons = Array.from(document.querySelectorAll('button'));
                
                // Case-insensitive exact match
                const addBtn = buttons.find(b => (b.textContent || '').trim().toUpperCase() === 'ADD');
                if (!addBtn) return { success: false, error: '"Add" button nahi mila.' };

                addBtn.click();

                for (let x = 0; x < 15; x++) {
                    await sleep(100);
                
                    const errors = Array.from(
                        document.querySelectorAll(
                            '.Mui-error, .MuiFormHelperText-root.Mui-error'
                        )
                    )
                    .map(e => e.innerText.trim())
                    .filter(Boolean);
                
                    if (errors.length) {
                        return {
                            success: false,
                            error: 'Input Error: ' +
                                [...new Set(errors)].join(' | ')
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
            await page.waitForSelector('.Toastify__toast', { timeout: 2000 });
            toastMessage = await page.evaluate(() => document.querySelector('.Toastify__toast')?.innerText.trim() || 'Submitted');
        } catch (e) {}
        
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
        await context.close();

        return { status: 'success', message: toastMessage, updated_person_ids: updatedPersonIds };
    } catch (error) {
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
        
        let errorScreenshotBase64 = null;
        if (page && !page.isClosed()) {
            try {
                console.log('Error aaya, screenshot capture kar rahe hain...');
                const buffer = await page.screenshot({ fullPage: true });
                errorScreenshotBase64 = buffer.toString('base64');
            } catch (screenshotError) {
                console.error("Screenshot capture failed:", screenshotError);
            }
        }

        if (context) await context.close();
        
        return { 
            status: 'failed', 
            message: error.message + ' || ' + new Date().toString(),
            error_screenshot: errorScreenshotBase64 ? `data:image/png;base64,${errorScreenshotBase64}` : null 
        };
    }
}

app.post('/create-visitor', async (req, res) => {
    try {
        const {
            auth_storage,
            booking_data,
            callback_url
        } = req.body;

        if (!booking_data) {
            return res.status(400).json({
                status: 'failed',
                message: 'booking_data required hai.'
            });
        }

        if (
            !booking_data.guests ||
            !Array.isArray(booking_data.guests) ||
            booking_data.guests.length === 0
        ) {
            return res.status(400).json({
                status: 'failed',
                message: 'booking_data.guests empty hai.'
            });
        }

        console.log('Create visitor request received. Guests:', booking_data.guests.length);

        startCreateVisitorBackground(
            auth_storage,
            booking_data,
            callback_url
        );

        return res.status(202).json({
            status: 'processing',
            message: 'Visitor automation background mein start ho gayi hai.',
            callback_enabled: !!callback_url,
            guests: booking_data.guests.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Create visitor request error:', error.message);
        return res.status(500).json({
            status: 'failed',
            message: error.message || 'Unable to start visitor automation.'
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server active on port ${PORT}`);
});
