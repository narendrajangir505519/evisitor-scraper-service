const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const path = require('path');
const axios = require('axios'); // File download karne ke liye (npm install axios)

const app = express();
app.use(express.json());

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
                '--no-zygote'
            ],
            defaultViewport: { width: 1280, height: 800 },
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
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
            ],
            defaultViewport: { width: 1280, height: 800 },
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
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
    const { cookies, auth_storage, visitor_data } = req.body;
    const visitorsUrl = 'https://evisitor.rajasthan.gov.in/evisitor/user/visitors';
    let browser = null;
    let tempDocPath = null;

    try {
        // 1. Browser Launch
        browser = await puppeteer.launch({
            args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
            defaultViewport: { width: 1280, height: 800 },
            executablePath: await chromium.executablePath(),
            headless: true,
        });

        const page = await browser.newPage();

        // 2. Base URL Open & LocalStorage Injection
        await page.goto('https://evisitor.rajasthan.gov.in/evisitor', {
            waitUntil: 'domcontentloaded'
        });

        if (auth_storage) {
            await page.evaluate((storage) => {
                if (storage.localStorage) {
                    Object.keys(storage.localStorage).forEach(key => {
                        localStorage.setItem(key, storage.localStorage[key]);
                    });
                }
                if (storage.sessionStorage) {
                    Object.keys(storage.sessionStorage).forEach(key => {
                        sessionStorage.setItem(key, storage.sessionStorage[key]);
                    });
                }
            }, auth_storage);
        }

        // 3. Cookies Set Karein (Agar available ho)
        if (cookies && cookies.length > 0) {
            await page.setCookie(...cookies);
        }

        // 4. Visitors Page Par Navigate Karein
        console.log('Navigating to Visitors Page...');
        await page.goto(visitorsUrl, { waitUntil: 'networkidle2', timeout: 35000 });

        const currentUrl = page.url();
        if (!currentUrl.includes('/user/visitors') && page.url().includes('login')) {
            throw new Error('Session expire ho gaya hai ya invalid auth data hai.');
        }

        // 5. 'CREATE VISITOR' Modal Open Karna
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

        // Modal animations aur React inputs ready hone ka wait karein
        await new Promise(r => setTimeout(r, 2000));

        // 6. Form Filling Logic (Chrome Extension Script Directly Evaluated)
        console.log('Filling form using Extension Engine...');

        await page.evaluate(async (g) => {
            function sleep(ms) {
                return new Promise(r => setTimeout(r, ms));
            }

            function norm(v) {
                return String(v || '').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            }

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
                } catch (e) {
                    console.warn('input failed', e);
                    return false;
                }
            }

            function setInputByName(name, value) {
                if (value === undefined || value === null) return false;
                const el = document.querySelector(`[name="${name}"]`);
                if (!el) return false;
                return fireReactInput(el, value);
            }

            function getComboByIndex(i) {
                return Array.from(document.querySelectorAll('[role="combobox"]'))[i] || null;
            }

            async function selectComboByIndex(index, optionText) {
                if (!optionText) return false;
                const combo = getComboByIndex(index);
                if (!combo) return false;

                combo.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await sleep(300);
                combo.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                combo.click();
                await sleep(500);

                const options = Array.from(document.querySelectorAll('li[role="option"][tabindex="-1"], li[role="option"]')).filter(o => {
                    const t = (o.innerText || o.textContent || '').replace(/\u200B/g, '').trim();
                    return t !== '';
                });

                const need = norm(optionText);

                const option = options.find(o => {
                    const text = norm(o.innerText || o.textContent);
                    if (text === need) return true;
                    return (
                        text.startsWith(need + ' ') ||
                        text.endsWith(' ' + need) ||
                        text.includes(' ' + need + ' ')
                    );
                });

                if (!option) {
                    document.body.click();
                    return false;
                }

                option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                option.click();
                await sleep(300);

                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
                await sleep(200);
                document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                document.body.click();
                await sleep(500);
                return true;
            }

            function getGender(v) {
                const x = norm(v);
                if (x === 'female' || x === 'f') return 'Female';
                if (x === 'male' || x === 'm') return 'Male';
                if (x === 'other' || x === 'o') return 'Other';
                return 'Male';
            }

            function setDocumentNumber(value) {
                if (!value) return false;
                const selectors = [
                    'input[name="documentNumber"]',
                    'input[placeholder="Enter document number"]',
                    'input[inputmode="text"][maxlength="25"]'
                ];
                for (const selector of selectors) {
                    const el = document.querySelector(selector);
                    if (el) return fireReactInput(el, value);
                }
                return false;
            }

            // --- Form Field Mapping & Async Execution ---
            const map = {
                roomNumber: g.room_number || g.roomNumber,
                checkInDateTime: g.checkInDateTime,
                checkOutDateTime: g.checkOutDateTime,
                comingLocation: g.coming_from || g.districtcd || g.comingLocation,
                goingLocation: g.going_to || g.goingLocation,
                note: g.note || '',
                name: g.full_name || g.name || g.guest_name || g.person_name,
                mobileNumber: g.mobile_number || g.mobileNumber || g.mobile,
                email: g.email || '',
                dateOfBirth: g.dateOfBirth || g.dob || '',
                address: g.address || ''
            };

            Object.entries(map).forEach(([n, v]) => setInputByName(n, v));

            // Select Dropdowns with Server-Side Dynamic Response Delays
            await selectComboByIndex(0, g.visit_reason || g.visitReasonType || 'Tourism');
            await selectComboByIndex(1, getGender(g.gender));
            await selectComboByIndex(2, g.nationality || 'INDIA');
            await sleep(800);

            // State Selection (Triggers District loading on Server)
            await selectComboByIndex(3, g.stateCd || g.state || 'Rajasthan');
            await sleep(1200); // Server call wait

            // District Selection
            await selectComboByIndex(4, g.districtcd || g.district || 'Jaipur');
            await selectComboByIndex(6, g.document_type || g.documentType || g.id_type || 'Aadhaar Card');

            const docType = g.document_type || g.documentType || '';
            if (docType !== 'Aadhaar Card') {
                await sleep(800);
                await setDocumentNumber(g.document_number || g.documentNumber || g.person_id);
                await sleep(800);
            }

        }, visitor_data);

        // 7. Document Image Download & Upload Handler
        const imageUrl = visitor_data.document_url || visitor_data.document_path;
        if (imageUrl) {
            console.log('Processing Document File Upload...');
            if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
                tempDocPath = path.join('/tmp', `doc_${Date.now()}.jpg`);
                await downloadImage(imageUrl, tempDocPath);
            } else {
                tempDocPath = imageUrl;
            }

            if (fs.existsSync(tempDocPath)) {
                const fileInput = await page.$('input[type="file"]');
                if (fileInput) {
                    await fileInput.uploadFile(tempDocPath);
                    console.log('File successfully uploaded into input.');
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }

        // 8. 'Add' Button Par Click Karein
        console.log('Clicking Add Button...');
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const addBtn = buttons.find(b => b.textContent.trim() === 'Add');
            if (addBtn) addBtn.click();
        });
        await new Promise(r => setTimeout(r, 1500));

        // 9. 'Submit Check-In' / 'Submit' Button Par Click Karein
        console.log('Submitting Final Check-In...');
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const submitBtn = buttons.find(b => {
                const txt = b.textContent.trim();
                return txt.includes('Submit Check-In') || txt === 'Submit';
            });
            if (submitBtn) submitBtn.click();
        });

        // 10. Toast Notification Response Capture Karein
        let toastData = { success: false, message: '' };
        try {
            await page.waitForSelector('.Toastify__toast', { timeout: 10000 });
            toastData = await page.evaluate(() => {
                const toastEl = document.querySelector('.Toastify__toast');
                if (!toastEl) return { success: false, message: '' };
                const text = toastEl.innerText ? toastEl.innerText.trim() : '';
                const isSuccessClass = toastEl.classList.contains('Toastify__toast--success');
                const isSuccessText = text.toLowerCase().includes('success') || text.toLowerCase().includes('saved');
                return { success: isSuccessClass || isSuccessText, message: text };
            });
        } catch (e) {
            console.log('Toast capture timeout or toast absent.');
        }

        // Temporary Download File Cleanup
        if (tempDocPath && fs.existsSync(tempDocPath) && tempDocPath.startsWith('/tmp')) {
            fs.unlinkSync(tempDocPath);
        }

        await browser.close();

        if (toastData.success) {
            return res.json({
                status: 'success',
                message: toastData.message || 'Visitor check-in created successfully!'
            });
        } else {
            return res.status(400).json({
                status: 'failed',
                message: toastData.message || 'Form submit command execute hui, par portal se success confirmation nahi mila.'
            });
        }

    } catch (error) {
        if (tempDocPath && fs.existsSync(tempDocPath) && tempDocPath.startsWith('/tmp')) {
            try { fs.unlinkSync(tempDocPath); } catch (e) {}
        }
        if (browser) await browser.close();
        return res.status(500).json({
            status: 'error',
            message: 'Automation Exception: ' + error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server active on port ${PORT}`);
});
