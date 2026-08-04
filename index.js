const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('E-Visitor Automation Microservice is Live!');
});

app.post('/login-evisitor', async (req, res) => {
    const { url, sso_id, password } = req.body;

    if (!url || !sso_id || !password) {
        return res.status(400).json({ error: 'url, sso_id aur password zaroori hain.' });
    }

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

        // 1. Target URL open karein
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // 2. Main Login button par click karein (modal open karne ke liye)
        const topLoginBtn = await page.$('button.login-btn');
        if (topLoginBtn) {
            await topLoginBtn.click();
            // Modal render hone ka wait karein
            await page.waitForSelector('input[placeholder="Enter SSO ID"]', { timeout: 10000 });
        }

        // 3. DOM se Captcha Text extract karein
        const captchaCode = await page.evaluate(() => {
            // Priority 1: Direct Class selector
            const el = document.querySelector('.css-uayl0r');
            if (el && el.innerText.trim()) {
                return el.innerText.trim();
            }

            // Priority 2: Fallback - Captcha input field ke paas wala Text box dhoondhein
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
            throw new Error('CAPTCHA code DOM me nahi mila.');
        }

        // 4. Input Fields me Data Fill Karein
        
        // SSO ID Field
        await page.click('input[placeholder="Enter SSO ID"]', { clickCount: 3 });
        await page.type('input[placeholder="Enter SSO ID"]', sso_id, { delay: 50 });

        // Password Field
        await page.click('input[placeholder="Enter Password"]', { clickCount: 3 });
        await page.type('input[placeholder="Enter Password"]', password, { delay: 50 });

        // Captcha Field
        await page.click('input[placeholder="Enter Captcha"]', { clickCount: 3 });
        await page.type('input[placeholder="Enter Captcha"]', captchaCode, { delay: 50 });

        // 5. Submit Button par Click Karein
        // Card ke andar wala Submit Button
        const submitButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(b => b.textContent.trim() === 'Submit');
        });

        if (submitButton) {
            await Promise.all([
                submitButton.click(),
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null)
            ]);
        }

        // 6. Login hone ke baad ka Session / Cookies / HTML Content Extract Karein
        const cookies = await page.cookies();
        const postLoginHtml = await page.content();

        await browser.close();

        return res.json({
            status: 'success',
            captcha_used: captchaCode,
            cookies: cookies,
            html: postLoginHtml
        });

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
