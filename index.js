process.env.TZ = 'Asia/Kolkata';

const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
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
    res.send('E-Visitor Automation Scraper is Active & Fast!');
});

async function getBrowser() {

    // Agar browser already available hai
    if (sharedBrowser) {
        try {
            // Browser alive hai ya nahi check
            const pages = await sharedBrowser.pages();

            if (pages) {
                return sharedBrowser;
            }
        } catch (e) {
            console.log('Old browser disconnected, creating new browser...');
            sharedBrowser = null;
        }
    }

    // Agar already browser start ho raha hai
    if (browserStarting) {
        return await browserStarting;
    }

    browserStarting = puppeteer.launch({
        args: [
            ...chromium.args,
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
        defaultViewport: {
            width: 1280,
            height: 800
        },
        executablePath: await chromium.executablePath(),
        headless: true
    });

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

    try {
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                 "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-extensions",
                "--disable-background-networking",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--disable-sync",
                "--no-first-run",
                "--no-zygote"
            ],
            defaultViewport: { width: 1280, height: 800 },
            executablePath: await chromium.executablePath(),
            headless: true,
        });

        const page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
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
        await page.close();

        return res.send(htmlContent);

    } catch (error) {
        if (browser) await page.close();
        return res.status(500).json({ error: 'Automation Error: ' + error.message });
    }
});

app.post('/login-evisitor', async (req, res) => {
    const { url, sso_id, password } = req.body;
    const loginBaseUrl = url || 'https://evisitor.rajasthan.gov.in/evisitor';
    let browser = null;

    try {
        browser = await getBrowser();

        const page = await browser.newPage();

        await page.setCacheEnabled(true);
        await page.setRequestInterception(true);

        page.on("request", request => {
            const type = request.resourceType();
        
            if (
                type === "image" ||
                type === "font" ||
                type === "media" ||
                type === "stylesheet"
            ) {
                request.abort();
            } else {
                request.continue();
            }
        });

        console.log('Not logged in. Redirected to login page. Starting login automation...');
        await page.goto(loginBaseUrl, { waitUntil: 'networkidle2', timeout: 20000 });

        const topLoginBtn = await page.$('button.login-btn');
        if (topLoginBtn) {
            await topLoginBtn.click();
        }

        await page.waitForSelector('input[placeholder="Enter SSO ID"]', { timeout: 10000 });

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
        await page.type('input[placeholder="Enter SSO ID"]', sso_id, { delay: 30 });

        await page.click('input[placeholder="Enter Password"]', { clickCount: 3 });
        await page.type('input[placeholder="Enter Password"]', password, { delay: 30 });

        await page.click('input[placeholder="Enter Captcha"]', { clickCount: 3 });
        await page.type('input[placeholder="Enter Captcha"]', captchaCode, { delay: 30 });

        const submitButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(b => b.textContent.trim() === 'Submit');
        });

        if (submitButton) {
            await submitButton.click();
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
            await page.close();
            return res.status(400).json({
                status: 'login_failed',
                toast_message: toastData.message,
                captcha_used: captchaCode
            });
        }

        await page.waitForFunction(() => !document.querySelector('.login-card'), { timeout: 10000 }).catch(() => null);
        await new Promise(resolve => setTimeout(resolve, 4000));

        const nextPageHtml = await page.content();
        const client = await page.target().createCDPSession();
        const cdpCookies = await client.send('Network.getAllCookies');
        const allCookies = cdpCookies.cookies || [];

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

        await page.close();

        return res.json({
            status: 'success',
            toast_message: toastData.message || 'Login Successful',
            captcha_used: captchaCode,
            cookies: allCookies,
            auth_storage: authStorage,
            next_page_html: nextPageHtml
        });

    } catch (error) {
        if (browser) await page.close();
        return res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});


// CREATE VISITOR AUTOMATION ENDPOINT
app.post('/create-visitor', async (req, res) => {
    const { auth_storage, booking_data } = req.body;
    const visitorsUrl = 'https://evisitor.rajasthan.gov.in/evisitor/user/visitors';
    
    // VARIABLES MOVED TO OUTER SCOPE FOR SCREENSHOT ACCESS
    let browser = null;
    let page = null; 
    let tempFiles = [];
    const updatedPersonIds = [];

    try {
        browser = await getBrowser();

        page = await browser.newPage(); // Assigned page here

        await page.setCacheEnabled(true);
        await page.setRequestInterception(true);

        page.on("request", request => {
            const type = request.resourceType();
        
            if (
                type === "image" ||
                type === "font" ||
                type === "media" ||
                type === "stylesheet"
            ) {
                request.abort();
            } else {
                request.continue();
            }
        });

        await page.emulateTimezone('Asia/Kolkata');

        await page.goto('https://evisitor.rajasthan.gov.in/evisitor', { waitUntil: 'domcontentloaded' });
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
        await page.goto(visitorsUrl, { waitUntil: 'networkidle2', timeout: 20000 });

        if (page.url().includes('login') || !page.url().includes('/user/visitors')) {
            throw new Error('Session expire ho gaya hai ya invalid auth data hai.');
        }

        const createBtnClicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const targetBtn = buttons.find(b => {
                const txt = b.textContent.trim().toUpperCase();
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
                    
                            console.log(
                                `No match for "${optionText}" → selecting 2nd option:`,
                                defaultOption.innerText.trim()
                            );
                    
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

                // if (g.nationality) {
                //     await selectComboByTarget('nationality', 2, g.nationality);
                //     await sleep(80);
                // }

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
                            await fileInputs[fIdx].uploadFile(downloadedDocPaths[fIdx]);
                            await page.evaluate((el) => {
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                el.dispatchEvent(new Event('blur', { bubbles: true }));
                            }, fileInputs[fIdx]);
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    } else {
                        const singleInput = fileInputs[0];
                        for (let fIdx = 0; fIdx < downloadedDocPaths.length; fIdx++) {
                            await singleInput.uploadFile(downloadedDocPaths[fIdx]);
                            await page.evaluate((el) => {
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                el.dispatchEvent(new Event('blur', { bubbles: true }));
                            }, singleInput);
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    }
                }
            }

            console.log(`Clicking 'Add' button for Guest ${i + 1}...`);
            const addResult = await page.evaluate(async () => {
                const sleep = ms => new Promise(r => setTimeout(r, ms));
                const buttons = Array.from(document.querySelectorAll('button'));
                const addBtn = buttons.find(b => b.textContent.trim() === 'Add');
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
                
                    // Agar error nahi hai aur Add ke baad form reset ho gaya
                    // to process continue kar sakte hain.
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
                // YE ERROR THROW HOGA TOH CATCH BLOCK ME JAYEGA AUR SCREENSHOT LEGA
                throw new Error(`Guest ${i + 1} (${guest.full_name || 'Guest'}) Add nahi ho paya: ${addResult.error}`);
            }
            // Guest successfully Add ho gaya
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
        await page.close();

        return res.json({ status: 'success', message: toastMessage, updated_person_ids: updatedPersonIds, });

    } catch (error) {
        // ERROR AANE PAR YAHAN AAYEGA
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
        
        let errorScreenshotBase64 = null;
        
        // BROWSER CLOSE HONE SE PEHLE SCREENSHOT LENA
        if (page && !page.isClosed()) {
            try {
                console.log('Error aaya, screenshot capture kar rahe hain...');
                // fullPage true rakha hai taaki poora error form dikhe
                errorScreenshotBase64 = await page.screenshot({ encoding: 'base64', fullPage: true }); 
            } catch (screenshotError) {
                console.error("Screenshot capture failed:", screenshotError);
            }
        }

        if (browser) await page.close();
        
        return res.status(400).json({ 
            status: 'failed', 
            message: error.message +' || '+ new Date().toString(),
            // JSON ME BASE64 IMAGE BHEJ RAHE HAI
            error_screenshot: errorScreenshotBase64 ? `data:image/png;base64,${errorScreenshotBase64}` : null 
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server active on port ${PORT}`);
});
