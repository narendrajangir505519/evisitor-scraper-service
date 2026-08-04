const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/scrape', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send('URL query parameter missing hai');
    }

    try {
        const browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        
        // Page load hone ka wait karein
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        
        const html = await page.content();
        await browser.close();

        res.send(html);
    } catch (error) {
        res.status(500).send('Scraping Error: ' + error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Scraper service running on port ${PORT}`);
});