const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Root URL Keep-Alive ke liye
app.get('/', (req, res) => {
    res.send('E-Visitor Automation Scraper is Active & Fast!');
});

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
    const visitorsUrl = 'https://evisitor.rajasthan.gov.in/evisitor/user/visitors';
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
        // STEP 1: Pehle Directly Visitors URL Hit Karke Session Check Karein
        // -------------------------------------------------------------
        console.log('Checking existing session via Visitors URL...');
        await page.goto(visitorsUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);

        const currentUrl = page.url();

        // Agar Redirect nahi hua aur URL par '/user/visitors' maujood hai = LOGIN ALREADY ACTIVE
        if (currentUrl.includes('/user/visitors')) {
            console.log('Session active! Already logged in.');
            const pageHtml = await page.content();
            const cookies = await page.cookies();
            await browser.close();

            return res.json({
                status: 'already_logged_in',
                toast_message: 'Session Already Active',
                cookies: cookies,
                next_page_html: pageHtml
            });
        }

        // -------------------------------------------------------------
        // STEP 2: Agar Redirect Ho Gaya -> Login Process Start Karein
        // -------------------------------------------------------------
        console.log('Not logged in. Redirected to login page. Starting login automation...');
        
        if (!currentUrl.includes('/evisitor')) {
            await page.goto(loginBaseUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        }

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
        const client = await page.target().createCDPSession();
const cookiesResult = await client.send('Network.getAllCookies');
const cookies = cookiesResult.cookies;

        await browser.close();

        return res.json({
            status: 'success',
            toast_message: toastData.message || 'Login Successful',
            captcha_used: captchaCode,
            cookies: cookies,
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
    const { cookies, visitor_data } = req.body;

    // Validation: Cookies aur Data zaruri hai
    if (!cookies || !visitor_data) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Cookies aur visitor_data required hain.' 
        });
    }

    const visitorsUrl = 'https://evisitor.rajasthan.gov.in/evisitor/user/visitors';
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
            headless: chromium.headless, // Production me true rakhein
        });

        const page = await browser.newPage();

        // 1. Session restore karne ke liye Cookies set karein
        await page.setCookie(...cookies);

        // 2. Visitors page par jayein
        console.log('Navigating to Visitors Page...');
        await page.goto(visitorsUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        const currentUrl = page.url();
        if (!currentUrl.includes('/user/visitors')) {
            throw new Error('Session expire ho gaya hai ya invalid cookies hain. Kripya dobara login karein.');
        }

        // 3. 'CREATE VISITOR' Modal Open Karna
        console.log('Opening Create Visitor Modal...');
        const createBtn = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            // Button ka text match karein (Apni UI ke hisab se text change karein agar zarurat ho)
            return buttons.find(b => b.textContent.trim().toUpperCase().includes('CREATE VISITOR') || b.textContent.trim().includes('Check-In'));
        });
        
        if (createBtn) {
            await createBtn.click();
            await page.waitForTimeout(2000); // Modal animation ka wait karein
        }

        // 4. Form Fill Karna (IDs ko apne actual E-visitor portal ke HTML se match karein)
        console.log('Filling form data...');
        
        // Helper function text type karne ke liye
        const typeData = async (selector, text) => {
            if (text) {
                const el = await page.$(selector).catch(() => null);
                if (el) {
                    await page.click(selector, { clickCount: 3 }); // clear existing
                    await page.type(selector, text, { delay: 10 });
                }
            }
        };

        // Text Fields
        await typeData('input[name="room_number"], #room_number', visitor_data.room_number);
        await typeData('input[name="coming_from"], #coming_from', visitor_data.coming_from);
        await typeData('input[name="going_to"], #going_to', visitor_data.going_to);
        await typeData('input[name="full_name"], #full_name', visitor_data.full_name);
        await typeData('input[name="mobile_number"], #mobile_number', visitor_data.mobile_number);
        await typeData('input[name="document_number"], #document_number', visitor_data.document_number);
        
        if (visitor_data.address) {
            await typeData('textarea[name="address"], #address, input[name="address"]', visitor_data.address);
        }

        // Dropdowns (Select tags)
        const selectData = async (selector, value) => {
            if (value) {
                const el = await page.$(selector).catch(() => null);
                if (el) await page.select(selector, value);
            }
        };

        await selectData('select[name="visit_reason"], #visit_reason', visitor_data.visit_reason);
        await selectData('select[name="gender"], #gender', visitor_data.gender);
        await selectData('select[name="document_type"], #document_type', visitor_data.document_type);

        // 5. Document / File Upload
        if (visitor_data.document_path) {
            console.log('Uploading Document:', visitor_data.document_path);
            if (fs.existsSync(visitor_data.document_path)) {
                const fileInput = await page.$('input[type="file"]');
                if (fileInput) {
                    await fileInput.uploadFile(visitor_data.document_path);
                }
            } else {
                console.log('Warning: File path exist nahi karta ->', visitor_data.document_path);
            }
        }

        // 6. 'Add' button par click karein (List me add karne ke liye)
        const addBtn = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(b => b.textContent.trim() === 'Add');
        });
        if (addBtn) {
            await addBtn.click();
            await page.waitForTimeout(1000); // Wait for list update
        }

        // 7. Final 'Submit Check-In' button par click karein
        const submitFinalBtn = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(b => b.textContent.trim().includes('Submit Check-In') || b.textContent.trim() === 'Submit');
        });
        if (submitFinalBtn) {
            await submitFinalBtn.click();
        }

        // 8. Toast/Success Status Capture Karein (Aapke login wale logic jaisa)
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
            console.log('Toast capture timeout.');
        }

        await browser.close();

        if (toastData.success) {
            return res.json({
                status: 'success',
                message: toastData.message || 'Visitor successfully created!'
            });
        } else {
            return res.status(400).json({
                status: 'failed',
                message: toastData.message || 'Form submit hua par success message nahi mila.',
            });
        }

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({
            status: 'error',
            message: 'Automation Error: ' + error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server active on port ${PORT}`);
});
