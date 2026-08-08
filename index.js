const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');
const axios = require('axios'); // File download karne ke liye (npm install axios)

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;

// Root URL Keep-Alive ke liye
app.get('/', (req, res) => {
    res.send('E-Visitor Automation Scraper is Active & Fast!');
});

// Helper function: Document Image Download karne ke liye
async function downloadImage(url, destPath) {
    const writer = fs.createWriteStream(destPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// Main Automation & Scraper Endpoint
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
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run',
                '--single-process',
                '--no-zygote'
            ],
            defaultViewport: { width: 1280, height: 800 },
            executablePath: await chromium.executablePath(),
            headless: true,
        });

        const page = await browser.newPage();

        // SPEED OPTIMIZATION: Images, Fonts, aur Stylesheets Block karein
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Page Visit
        await page.goto(targetUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        });

        // AUTOMATION STEPS (Agar Form Fill / Click karna ho):
        // Example: Pehle element ke aane ka wait karein
        try {
            await page.waitForSelector('body', { timeout: 5000 });
            
            // Agar kisi specific input/button ko automations se handle karna ho:
            /*
            if (req.body.search_term) {
                await page.type('#search_input', req.body.search_term);
                await page.click('#submit_button');
                await page.waitForNetworkIdle();
            }
            */
        } catch (e) {
            console.log('Element wait timeout, proceeding anyway...');
        }

        // Final HTML Content Extract karein
        const htmlContent = await page.content();

        await browser.close();

        return res.send(htmlContent);

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: 'Automation Error: ' + error.message });
    }
});

app.post('/login-evisitor', async (req, res) => {
    const { url, sso_id, password } = req.body;

    // Direct Protected Visitors URL
    const loginBaseUrl = url || 'https://evisitor.rajasthan.gov.in/evisitor';

    let browser = null;

    try {
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
            ],
            defaultViewport: { width: 1280, height: 800 },
            executablePath: await chromium.executablePath(),
            headless: true,
        });

        const page = await browser.newPage();

        // -------------------------------------------------------------
        // STEP 2: Agar Redirect Ho Gaya -> Login Process Start Karein
        // -------------------------------------------------------------
        console.log('Not logged in. Redirected to login page. Starting login automation...');
        
        await page.goto(loginBaseUrl, { waitUntil: 'networkidle2', timeout: 45000 });

        // Top Login Button Click
        const topLoginBtn = await page.$('button.login-btn');
        if (topLoginBtn) {
            await topLoginBtn.click();
        }

        // Login Modal aur SSO ID Field aane ka wait karein
        await page.waitForSelector('input[placeholder="Enter SSO ID"]', { timeout: 15000 });

        // CAPTCHA Element ka DOM me aane ka wait karein
        try {
            await page.waitForSelector('.css-uayl0r', { timeout: 8000 });
        } catch (e) {
            console.log('Captcha selector wait timeout, evaluating DOM...');
        }

        // CAPTCHA Extract Karein
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

        // Form Inputs Fill Karein
        await page.click('input[placeholder="Enter SSO ID"]', { clickCount: 3 });
        await page.type('input[placeholder="Enter SSO ID"]', sso_id, { delay: 30 });

        await page.click('input[placeholder="Enter Password"]', { clickCount: 3 });
        await page.type('input[placeholder="Enter Password"]', password, { delay: 30 });

        await page.click('input[placeholder="Enter Captcha"]', { clickCount: 3 });
        await page.type('input[placeholder="Enter Captcha"]', captchaCode, { delay: 30 });

        // Submit Click
        const submitButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(b => b.textContent.trim() === 'Submit');
        });

        if (submitButton) {
            await submitButton.click();
        }

        // Toast Status Capture
        let toastData = { success: false, message: '' };
        try {
            await page.waitForSelector('.Toastify__toast', { timeout: 8000 });
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

        // Invalid Credentials / Captcha Error
        if (toastData.message && !toastData.success) {
            await browser.close();
            return res.status(400).json({
                status: 'login_failed',
                toast_message: toastData.message,
                captcha_used: captchaCode
            });
        }

        // Login ke baad Visitors Page Navigate hone ka wait karein
        await page.waitForFunction(() => !document.querySelector('.login-card'), { timeout: 15000 }).catch(() => null);
        await new Promise(resolve => setTimeout(resolve, 4000));

        const nextPageHtml = await page.content();
        // const cookies = await page.cookies();
        // ⭐ TAREOKA 1: CDP Session Se Browser Ki SABHI Domains Ki Cookies Fetch Karein
        const client = await page.target().createCDPSession();
        const cdpCookies = await client.send('Network.getAllCookies');
        const allCookies = cdpCookies.cookies || [];

        // ⭐ TAREOKA 2: LocalStorage Aur SessionStorage Ka Data Nikalein
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

        await browser.close();

        return res.json({
            status: 'success',
            toast_message: toastData.message || 'Login Successful',
            captcha_used: captchaCode,
            cookies: allCookies,
            auth_storage: authStorage,
            next_page_html: nextPageHtml
        });

    } catch (error) {
        if (browser) await browser.close();
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
    let browser = null;
    let tempFiles = [];

    try {
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ],
            defaultViewport: { width: 1280, height: 800 },
            executablePath: await chromium.executablePath(),
            headless: true,
        });

        const page = await browser.newPage();

        // Console logs capture for debugging
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));

        // 1. Session Setup
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

        // 2. Open Visitors Page
        console.log('Navigating to Visitors Page...');
        await page.goto(visitorsUrl, { waitUntil: 'networkidle2', timeout: 35000 });

        if (page.url().includes('login') || !page.url().includes('/user/visitors')) {
            throw new Error('Session expire ho gaya hai ya invalid auth data hai.');
        }

        // 3. Click Create Visitor
        console.log('Opening Create Visitor Modal...');
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

        await new Promise(r => setTimeout(r, 2000));

        // 4. Booking Level Fields
        console.log('Filling Booking Level Details...');
        const bookingFillResult = await page.evaluate(async (bData) => {
            function safeSetInputValue(el, value) {
                if (!el) return false;
                const val = value ?? '';
                try {
                    const proto = Object.getPrototypeOf(el);
                    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value') ||
                                       Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ||
                                       Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
                    
                    if (descriptor && descriptor.set) {
                        descriptor.set.call(el, val);
                    } else {
                        el.value = val;
                    }
                } catch (e) {
                    el.value = val;
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
                return true;
            }

            function setInputByName(name, value) {
                const el = document.querySelector(`[name="${name}"]`);
                return el ? safeSetInputValue(el, value) : false;
            }

            try {
                let checkInTime = bData.check_in_date_time;
                if (checkInTime) {
                    let formatted = String(checkInTime).trim().replace(' ', 'T');
                    let parsedDate = new Date(formatted);
                    safeTime = parsedDate;
                }
                setInputByName('checkInDateTime', safeTime);
                setInputByName('roomNumber', bData.room_number || '101');
                setInputByName('comingLocation', bData.coming_from || 'Sikar');
                setInputByName('goingLocation', bData.going_to || 'Sikar');

                const combo = document.querySelectorAll('[role="combobox"]')[0];
                if (combo) {
                    combo.click();
                    await new Promise(r => setTimeout(r, 400));
                    const options = Array.from(document.querySelectorAll('li[role="option"], div[role="option"]'));
                    const targetReason = String(bData.visit_reason || '').toLowerCase();
                    const opt = options.find(o => o.textContent.toLowerCase().includes(targetReason)) || options[0];
                    if (opt) opt.click();
                }
                return { success: true };
            } catch (err) {
                return { success: false, field: 'Booking Base Fields', error: err.message };
            }
        }, booking_data);

        if (!bookingFillResult.success) {
            throw new Error(`Error at ${bookingFillResult.field}: ${bookingFillResult.error}`);
        }

        // 5. Guests Loop
        const guests = booking_data.guests || [];
        console.log(`Processing ${guests.length} guests...`);

        for (let i = 0; i < guests.length; i++) {
            const guest = guests[i];
            console.log(`Filling Guest ${i + 1}: ${guest.full_name}`);

            const guestFillResult = await page.evaluate(async (g, index) => {
                const sleep = ms => new Promise(r => setTimeout(r, ms));

                function safeSetInputValue(el, value) {
                    if (!el) return false;
                    const val = value ?? '';
                    try {
                        const proto = Object.getPrototypeOf(el);
                        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value') ||
                                           Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ||
                                           Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');

                        if (descriptor && descriptor.set) {
                            descriptor.set.call(el, val);
                        } else {
                            el.value = val;
                        }
                    } catch (e) {
                        el.value = val;
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                    return true;
                }

                function setInputByName(name, value) {
                    const el = document.querySelector(`[name="${name}"]`);
                    return el ? safeSetInputValue(el, value) : false;
                }

                async function selectDropdown(idx, searchText) {
                    const combos = document.querySelectorAll('[role="combobox"]');
                    const combo = combos[idx];
                    if (!combo) return;
                    combo.click();
                    await sleep(400);
                    const options = Array.from(document.querySelectorAll('li[role="option"], div[role="option"]'));
                    const search = String(searchText || '').toLowerCase().trim();
                    const opt = options.find(o => o.textContent.toLowerCase().trim().includes(search)) || options[0];
                    if (opt) opt.click();
                    await sleep(300);
                }

                let currentStep = 'Init';
                try {
                    currentStep = 'Name';
                    setInputByName('name', g.full_name);

                    currentStep = 'Mobile';
                    setInputByName('mobileNumber', g.mobile_number);

                    currentStep = 'Address';
                    setInputByName('address', g.address);

                    currentStep = 'Document Number';
                    setInputByName('documentNumber', g.document_number);

                    currentStep = 'Gender Dropdown';
                    await selectDropdown(1, g.gender || 'Male');

                    currentStep = 'Nationality Dropdown';
                    await selectDropdown(2, g.nationality || 'INDIA');

                    currentStep = 'State Dropdown';
                    await selectDropdown(3, g.state || 'Rajasthan');
                    await sleep(500);

                    currentStep = 'District Dropdown';
                    await selectDropdown(4, g.district || 'Sikar');

                    currentStep = 'Document Type Dropdown';
                    await selectDropdown(5, g.document_type || 'Aadhaar Card');

                    return { success: true };
                } catch (err) {
                    return { success: false, field: currentStep, error: err.message };
                }
            }, guest, i);

            if (!guestFillResult.success) {
                throw new Error(`Guest ${i + 1} (${guest.full_name}) failed at field '${guestFillResult.field}': ${guestFillResult.error}`);
            }

            // Image Upload
            let docPath = path.join('/tmp', `doc_${Date.now()}_${i}.jpg`);
            if (guest.document_url && (guest.document_url.startsWith('http://') || guest.document_url.startsWith('https://'))) {
                try {
                    await downloadImage(guest.document_url, docPath);
                    tempFiles.push(docPath);
                } catch (e) {
                    docPath = null;
                }
            } else {
                docPath = null;
            }

            if (!docPath || !fs.existsSync(docPath)) {
                docPath = path.join('/tmp', `dummy_${Date.now()}_${i}.jpg`);
                fs.writeFileSync(docPath, Buffer.from('/9j/4AAQScript...', 'base64'));
                tempFiles.push(docPath);
            }

            const fileInput = await page.$('input[type="file"]');
            if (fileInput && fs.existsSync(docPath)) {
                await fileInput.uploadFile(docPath);
                await page.evaluate(() => {
                    const el = document.querySelector('input[type="file"]');
                    if (el) {
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                });
                await new Promise(r => setTimeout(r, 800));
            }

            // Click Add
            console.log(`Clicking 'Add' button for Guest ${i + 1}...`);
            const addResult = await page.evaluate(async () => {
                const sleep = ms => new Promise(r => setTimeout(r, ms));
                const buttons = Array.from(document.querySelectorAll('button'));
                const addBtn = buttons.find(b => b.textContent.trim() === 'Add');
                if (!addBtn) return { success: false, error: '"Add" button nahi mila.' };

                addBtn.click();
                await sleep(1500);

                const errors = Array.from(document.querySelectorAll('.Mui-error, .MuiFormHelperText-root.Mui-error'))
                    .map(e => e.innerText.trim())
                    .filter(t => t.length > 0);

                if (errors.length > 0) {
                    return { success: false, error: 'Input Error: ' + [...new Set(errors)].join(' | ') };
                }
                return { success: true };
            });

            if (!addResult.success) {
                throw new Error(`Guest ${i + 1} (${guest.full_name}) Add nahi ho paya: ${addResult.error}`);
            }
        }

        // 6. Submit Check-In
        console.log('Submitting Final Check-In...');
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const submitBtn = buttons.find(b => {
                const txt = b.textContent.trim();
                return txt.includes('Submit Check-In') || txt === 'Submit';
            });
            if (submitBtn) submitBtn.click();
        });

        // 7. Toast Result
        let toastMessage = 'Visitor check-in submitted successfully.';
        try {
            await page.waitForSelector('.Toastify__toast', { timeout: 8000 });
            toastMessage = await page.evaluate(() => {
                const el = document.querySelector('.Toastify__toast');
                return el ? el.innerText.trim() : 'Submitted';
            });
        } catch (e) {}

        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
        await browser.close();

        return res.json({ status: 'success', message: toastMessage });

    } catch (error) {
        tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
        if (browser) await browser.close();
        return res.status(400).json({ status: 'failed', message: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server active on port ${PORT}`);
});
