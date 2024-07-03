import * as cheerio from "cheerio";
import { ScrapingBeeClient } from "scrapingbee";
import { extractMetadata } from "./utils/metadata";
import dotenv from "dotenv";
import { Document, PageOptions, FireEngineResponse, ExtractorOptions } from "../../lib/entities";
import { parseMarkdown } from "../../lib/html-to-markdown";
import { urlSpecificParams } from "./utils/custom/website_params";
import { fetchAndProcessPdf } from "./utils/pdfProcessor";
import { handleCustomScraping } from "./custom/handleCustomScraping";
import { removeUnwantedElements } from "./utils/removeUnwantedElements";
import axios from "axios";

dotenv.config();

const baseScrapers = [
  "fire-engine",
  "scrapingBee",
  "playwright",
  "scrapingBeeLoad",
  "fetch",
] as const;

const universalTimeout = 15000;

export async function generateRequestParams(
  url: string,
  wait_browser: string = "domcontentloaded",
  timeout: number = 15000
): Promise<any> {
  const defaultParams = {
    url: url,
    params: { timeout: timeout, wait_browser: wait_browser },
    headers: { "ScrapingService-Request": "TRUE" },
  };

  try {
    const urlKey = new URL(url).hostname.replace(/^www\./, "");
    if (urlSpecificParams.hasOwnProperty(urlKey)) {
      return { ...defaultParams, ...urlSpecificParams[urlKey] };
    } else {
      return defaultParams;
    }
  } catch (error) {
    console.error(`Error generating URL key: ${error}`);
    return defaultParams;
  }
}
import { logScrape } from "../../services/logging/scrape_log";

export async function scrapWithFireEngine({
  url,
  waitFor = 0,
  screenshot = false,
  pageOptions = { parsePDF: true },
  headers,
  options,
}: {
  url: string;
  waitFor?: number;
  screenshot?: boolean;
  pageOptions?: { scrollXPaths?: string[]; parsePDF?: boolean };
  headers?: Record<string, string>;
  options?: any;
}): Promise<FireEngineResponse> {

  const logParams = {
    url,
    scraper: "fire-engine",
    success: false,
    response_code: null,
    time_taken_seconds: null,
    error_message: "",
    html: "",
    startTime: Date.now(),
  };


  try {
    const reqParams = await generateRequestParams(url);
    const waitParam = reqParams["params"]?.wait ?? waitFor;
    const screenshotParam = reqParams["params"]?.screenshot ?? screenshot;
    console.log(
      `[Fire-Engine] Scraping ${url} with wait: ${waitParam} and screenshot: ${screenshotParam}`
    );

    const response = await axios.post(
      process.env.FIRE_ENGINE_BETA_URL + "/scrape",
      {
        url: url,
        wait: waitParam,
        screenshot: screenshotParam,
        headers: headers,
        pageOptions: pageOptions,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: universalTimeout + waitParam,
      }
    );

    if (response.status !== 200) {
      console.error(
        `[Fire-Engine] Error fetching url: ${url} with status: ${response.status}`
      );
      logParams.error_message = response.data?.pageError;
      logParams.response_code = response.data?.pageStatusCode;
      return {
        html: "",
        screenshot: "",
        pageStatusCode: response.data?.pageStatusCode,
        pageError: response.data?.pageError,
      };
    }

    const contentType = response.headers["content-type"];
    if (contentType && contentType.includes("application/pdf")) {
      const { content, pageStatusCode, pageError } = await fetchAndProcessPdf(
        url,
        pageOptions?.parsePDF
      );
      logParams.success = true;
      // We shouldnt care about the pdf logging here I believe
      return { html: content, screenshot: "", pageStatusCode, pageError };
    } else {
      const data = response.data;
      logParams.success = data.pageStatusCode >= 200 && data.pageStatusCode < 300 || data.pageStatusCode === 404;
      logParams.html = data.content ?? "";
      logParams.response_code = data.pageStatusCode;
      logParams.error_message = data.pageError;
      return {
        html: data.content ?? "",
        screenshot: data.screenshot ?? "",
        pageStatusCode: data.pageStatusCode,
        pageError: data.pageError,
      };
    }
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      console.log(`[Fire-Engine] Request timed out for ${url}`);
      logParams.error_message = "Request timed out";
    } else {
      console.error(`[Fire-Engine][c] Error fetching url: ${url} -> ${error}`);
      logParams.error_message = error.message || error;
    }
    return { html: "", screenshot: "" };
  } finally {
    const endTime = Date.now();
    const time_taken_seconds = (endTime - logParams.startTime) / 1000;
    await logScrape({
      url: logParams.url,
      scraper: logParams.scraper,
      success: logParams.success,
      response_code: logParams.response_code,
      time_taken_seconds,
      error_message: logParams.error_message,
      html: logParams.html,
    });
  }
}

export async function scrapWithScrapingBee(
  url: string,
  wait_browser: string = "domcontentloaded",
  timeout: number = universalTimeout,
  pageOptions: { parsePDF?: boolean } = { parsePDF: true }
): Promise<{ content: string; pageStatusCode?: number; pageError?: string }> {
  const logParams = {
    url,
    scraper: wait_browser === "networkidle2" ? "scrapingBeeLoad" : "scrapingBee",
    success: false,
    response_code: null,
    time_taken_seconds: null,
    error_message: "",
    html: "",
    startTime: Date.now(),
  };
  try {
    const client = new ScrapingBeeClient(process.env.SCRAPING_BEE_API_KEY);
    const clientParams = await generateRequestParams(
      url,
      wait_browser,
      timeout
    );
    const response = await client.get({
      ...clientParams,
      params: {
        ...clientParams.params,
        transparent_status_code: "True",
      },
    });
    const contentType = response.headers["content-type"];
    if (contentType && contentType.includes("application/pdf")) {
      logParams.success = true;
      const { content, pageStatusCode, pageError } = await fetchAndProcessPdf(url, pageOptions?.parsePDF);
      return { content, pageStatusCode, pageError };
    } else {
      let text = "";
      try {
        const decoder = new TextDecoder();
        text = decoder.decode(response.data);
        logParams.success = true;
      } catch (decodeError) {
        console.error(
          `[ScrapingBee][c] Error decoding response data for url: ${url} -> ${decodeError}`
        );
        logParams.error_message = decodeError.message || decodeError;
      }
      logParams.response_code = response.status;
      logParams.html = text;
      logParams.success = response.status >= 200 && response.status < 300 || response.status === 404;
      logParams.error_message = response.statusText != "OK" ? response.statusText : undefined;
      return {
        content: text,
        pageStatusCode: response.status,
        pageError:
          response.statusText != "OK" ? response.statusText : undefined,
      };
    }
  } catch (error) {
    console.error(`[ScrapingBee][c] Error fetching url: ${url} -> ${error}`);
    logParams.error_message = error.message || error;
    logParams.response_code = error.response?.status;
    return {
      content: "",
      pageStatusCode: error.response?.status,
      pageError: error.response?.statusText,
    };
  } finally {
    const endTime = Date.now();
    logParams.time_taken_seconds = (endTime - logParams.startTime) / 1000;
    await logScrape(logParams);
  }
}

export async function scrapWithPlaywright(
  url: string,
  waitFor: number = 0,
  headers?: Record<string, string>,
  pageOptions: { parsePDF?: boolean } = { parsePDF: true }
): Promise<{ content: string; pageStatusCode?: number; pageError?: string }> {
  const logParams = {
    url,
    scraper: "playwright",
    success: false,
    response_code: null,
    time_taken_seconds: null,
    error_message: "",
    html: "",
    startTime: Date.now(),
  };


  try {
    const reqParams = await generateRequestParams(url);
    // If the user has passed a wait parameter in the request, use that
    const waitParam = reqParams["params"]?.wait ?? waitFor;

    const response = await axios.post(
      process.env.PLAYWRIGHT_MICROSERVICE_URL,
      {
        url: url,
        wait_after_load: waitParam,
        headers: headers,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: universalTimeout + waitParam, // Add waitParam to timeout to account for the wait time
        transformResponse: [(data) => data], // Prevent axios from parsing JSON automatically
      }
    );

    if (response.status !== 200) {
      console.error(
        `[Playwright] Error fetching url: ${url} with status: ${response.status}`
      );
      logParams.error_message = response.data?.pageError;
      logParams.response_code = response.data?.pageStatusCode;
      return {
        content: "",
        pageStatusCode: response.data?.pageStatusCode,
        pageError: response.data?.pageError,
      };
    }

    const contentType = response.headers["content-type"];
    if (contentType && contentType.includes("application/pdf")) {
      logParams.success = true;
      return await fetchAndProcessPdf(url, pageOptions?.parsePDF);
    } else {
      const textData = response.data;
      try {
        const data = JSON.parse(textData);
        const html = data.content;
        logParams.success = true;
        logParams.html = html;
        logParams.response_code = data.pageStatusCode;
        logParams.error_message = data.pageError;
        return {
          content: html ?? "",
          pageStatusCode: data.pageStatusCode,
          pageError: data.pageError,
        };
      } catch (jsonError) {
        logParams.error_message = jsonError.message || jsonError;
        console.error(
          `[Playwright] Error parsing JSON response for url: ${url} -> ${jsonError}`
        );
        return { content: "" };
      }
    }
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      logParams.error_message = "Request timed out";
      console.log(`[Playwright] Request timed out for ${url}`);
    } else {
      logParams.error_message = error.message || error;
      console.error(`[Playwright] Error fetching url: ${url} -> ${error}`);
    }
    return { content: "" };
  } finally {
    const endTime = Date.now();
    logParams.time_taken_seconds = (endTime - logParams.startTime) / 1000;
    await logScrape(logParams);
  }
}

export async function scrapWithFetch(
  url: string,
  pageOptions: { parsePDF?: boolean } = { parsePDF: true }
): Promise<{ content: string; pageStatusCode?: number; pageError?: string }> {
  const logParams = {
    url,
    scraper: "fetch",
    success: false,
    response_code: null,
    time_taken_seconds: null,
    error_message: "",
    html: "",
    startTime: Date.now(),
  };


  try {
    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: universalTimeout,
      transformResponse: [(data) => data], // Prevent axios from parsing JSON automatically
    });

    if (response.status !== 200) {
      console.error(
        `[Axios] Error fetching url: ${url} with status: ${response.status}`
      );
      logParams.error_message = response.statusText;
      logParams.response_code = response.status;
      return {
        content: "",
        pageStatusCode: response.status,
        pageError: response.statusText,
      };
    }

    const contentType = response.headers["content-type"];
    if (contentType && contentType.includes("application/pdf")) {
      logParams.success = true;
      return await fetchAndProcessPdf(url, pageOptions?.parsePDF);
    } else {
      const text = response.data;
      const result = { content: text, pageStatusCode: 200 };
      logParams.success = true;
      logParams.html = text;
      logParams.response_code = 200;
      logParams.error_message = null;
      return result;
    }
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      logParams.error_message = "Request timed out";
      console.log(`[Axios] Request timed out for ${url}`);
    } else {
      logParams.error_message = error.message || error;
      console.error(`[Axios] Error fetching url: ${url} -> ${error}`);
    }
    return { content: "" };
  } finally {
    const endTime = Date.now();
    logParams.time_taken_seconds = (endTime - logParams.startTime) / 1000;
    await logScrape(logParams);
  }
}

/**
 * Get the order of scrapers to be used for scraping a URL
 * If the user doesn't have envs set for a specific scraper, it will be removed from the order.
 * @param defaultScraper The default scraper to use if the URL does not have a specific scraper order defined
 * @returns The order of scrapers to be used for scraping a URL
 */
function getScrapingFallbackOrder(
  defaultScraper?: string,
  isWaitPresent: boolean = false,
  isScreenshotPresent: boolean = false,
  isHeadersPresent: boolean = false
) {
  const availableScrapers = baseScrapers.filter((scraper) => {
    switch (scraper) {
      case "scrapingBee":
      case "scrapingBeeLoad":
        return !!process.env.SCRAPING_BEE_API_KEY;
      case "fire-engine":
        return !!process.env.FIRE_ENGINE_BETA_URL;
      case "playwright":
        return !!process.env.PLAYWRIGHT_MICROSERVICE_URL;
      default:
        return true;
    }
  });

  let defaultOrder = [
    "scrapingBee",
    "fire-engine",
    "playwright",
    "scrapingBeeLoad",
    "fetch",
  ];

  if (isWaitPresent || isScreenshotPresent || isHeadersPresent) {
    defaultOrder = [
      "fire-engine",
      "playwright",
      ...defaultOrder.filter(
        (scraper) => scraper !== "fire-engine" && scraper !== "playwright"
      ),
    ];
  }

  const filteredDefaultOrder = defaultOrder.filter(
    (scraper: (typeof baseScrapers)[number]) =>
      availableScrapers.includes(scraper)
  );
  const uniqueScrapers = new Set(
    defaultScraper
      ? [defaultScraper, ...filteredDefaultOrder, ...availableScrapers]
      : [...filteredDefaultOrder, ...availableScrapers]
  );

  const scrapersInOrder = Array.from(uniqueScrapers);
  return scrapersInOrder as (typeof baseScrapers)[number][];
}

export async function scrapSingleUrl(
  urlToScrap: string,
  pageOptions: PageOptions = {
    onlyMainContent: true,
    includeHtml: false,
    includeRawHtml: false,
    waitFor: 0,
    screenshot: false,
    headers: undefined,
  },
  extractorOptions: ExtractorOptions = {
    mode: "llm-extraction-from-markdown"
  },
  existingHtml: string = ""
): Promise<Document> {
  urlToScrap = urlToScrap.trim();

  const attemptScraping = async (
    url: string,
    method: (typeof baseScrapers)[number]
  ) => {
    let scraperResponse: {
      text: string;
      screenshot: string;
      metadata: { pageStatusCode?: number; pageError?: string | null };
    } = { text: "", screenshot: "", metadata: {} };
    let screenshot = "";
    switch (method) {
      case "fire-engine":
        if (process.env.FIRE_ENGINE_BETA_URL) {
          console.log(`Scraping ${url} with Fire Engine`);
          const response = await scrapWithFireEngine({
            url,
            waitFor: pageOptions.waitFor,
            screenshot: pageOptions.screenshot,
            pageOptions: pageOptions,
            headers: pageOptions.headers,
          });
          scraperResponse.text = response.html;
          scraperResponse.screenshot = response.screenshot;
          scraperResponse.metadata.pageStatusCode = response.pageStatusCode;
          scraperResponse.metadata.pageError = response.pageError;
        }
        break;
      case "scrapingBee":
        if (process.env.SCRAPING_BEE_API_KEY) {
          const response = await scrapWithScrapingBee(
            url,
            "domcontentloaded",
            pageOptions.fallback === false ? 7000 : 15000
          );
          scraperResponse.text = response.content;
          scraperResponse.metadata.pageStatusCode = response.pageStatusCode;
          scraperResponse.metadata.pageError = response.pageError;
        }
        break;
      case "playwright":
        if (process.env.PLAYWRIGHT_MICROSERVICE_URL) {
          const response = await scrapWithPlaywright(
            url,
            pageOptions.waitFor,
            pageOptions.headers
          );
          scraperResponse.text = response.content;
          scraperResponse.metadata.pageStatusCode = response.pageStatusCode;
          scraperResponse.metadata.pageError = response.pageError;
        }
        break;
      case "scrapingBeeLoad":
        if (process.env.SCRAPING_BEE_API_KEY) {
          const response = await scrapWithScrapingBee(url, "networkidle2");
          scraperResponse.text = response.content;
          scraperResponse.metadata.pageStatusCode = response.pageStatusCode;
          scraperResponse.metadata.pageError = response.pageError;
        }
        break;
      case "fetch":
        const response = await scrapWithFetch(url);
        scraperResponse.text = response.content;
        scraperResponse.metadata.pageStatusCode = response.pageStatusCode;
        scraperResponse.metadata.pageError = response.pageError;
        break;
    }

    let customScrapedContent: FireEngineResponse | null = null;

    // Check for custom scraping conditions
    const customScraperResult = await handleCustomScraping(
      scraperResponse.text,
      url
    );

    if (customScraperResult) {
      switch (customScraperResult.scraper) {
        case "fire-engine":
          customScrapedContent = await scrapWithFireEngine({
            url: customScraperResult.url,
            waitFor: customScraperResult.waitAfterLoad,
            screenshot: false,
            pageOptions: customScraperResult.pageOptions,
          });
          if (screenshot) {
            customScrapedContent.screenshot = screenshot;
          }
          break;
        case "pdf":
          const { content, pageStatusCode, pageError } =
            await fetchAndProcessPdf(
              customScraperResult.url,
              pageOptions?.parsePDF
            );
          customScrapedContent = {
            html: content,
            screenshot,
            pageStatusCode,
            pageError,
          };
          break;
      }
    }

    if (customScrapedContent) {
      scraperResponse.text = customScrapedContent.html;
      screenshot = customScrapedContent.screenshot;
    }

    //* TODO: add an optional to return markdown or structured/extracted content
    let cleanedHtml = removeUnwantedElements(scraperResponse.text, pageOptions);
    return {
      text: await parseMarkdown(cleanedHtml),
      html: cleanedHtml,
      rawHtml: scraperResponse.text,
      screenshot: scraperResponse.screenshot,
      pageStatusCode: scraperResponse.metadata.pageStatusCode,
      pageError: scraperResponse.metadata.pageError || undefined,
    };
  };

  let { text, html, rawHtml, screenshot, pageStatusCode, pageError } = {
    text: "",
    html: "",
    rawHtml: "",
    screenshot: "",
    pageStatusCode: 200,
    pageError: undefined,
  };
  try {
    let urlKey = urlToScrap;
    try {
      urlKey = new URL(urlToScrap).hostname.replace(/^www\./, "");
    } catch (error) {
      console.error(`Invalid URL key, trying: ${urlToScrap}`);
    }
    const defaultScraper = urlSpecificParams[urlKey]?.defaultScraper ?? "";
    const scrapersInOrder = getScrapingFallbackOrder(
      defaultScraper,
      pageOptions && pageOptions.waitFor && pageOptions.waitFor > 0,
      pageOptions && pageOptions.screenshot && pageOptions.screenshot === true,
      pageOptions && pageOptions.headers && pageOptions.headers !== undefined
    );

    for (const scraper of scrapersInOrder) {
      // If exists text coming from crawler, use it
      if (existingHtml && existingHtml.trim().length >= 100) {
        let cleanedHtml = removeUnwantedElements(existingHtml, pageOptions);
        text = await parseMarkdown(cleanedHtml);
        html = cleanedHtml;
        break;
      }

      const attempt = await attemptScraping(urlToScrap, scraper);
      text = attempt.text ?? "";
      html = attempt.html ?? "";
      rawHtml = attempt.rawHtml ?? "";
      screenshot = attempt.screenshot ?? "";
      
      if (attempt.pageStatusCode) {
        pageStatusCode = attempt.pageStatusCode;
      }
      if (attempt.pageError && attempt.pageStatusCode >= 400) {
        pageError = attempt.pageError;
      } else if (attempt.pageStatusCode < 400) {
        pageError = undefined;
      }

      if (text && text.trim().length >= 100) break;
      if (pageStatusCode && pageStatusCode == 404) break;
      const nextScraperIndex = scrapersInOrder.indexOf(scraper) + 1;
      if (nextScraperIndex < scrapersInOrder.length) {
        console.info(`Falling back to ${scrapersInOrder[nextScraperIndex]}`);
      }
    }

    if (!text) {
      throw new Error(`All scraping methods failed for URL: ${urlToScrap}`);
    }

    const soup = cheerio.load(rawHtml);
    const metadata = extractMetadata(soup, urlToScrap);

    let document: Document;
    if (screenshot && screenshot.length > 0) {
      document = {
        content: text,
        markdown: text,
        html: pageOptions.includeHtml ? html : undefined,
        rawHtml: pageOptions.includeRawHtml || extractorOptions.mode === "llm-extraction-from-raw-html" ? rawHtml : undefined,
        metadata: {
          ...metadata,
          screenshot: screenshot,
          sourceURL: urlToScrap,
          pageStatusCode: pageStatusCode,
          pageError: pageError,
        },
      };
    } else {
      document = {
        content: text,
        markdown: text,
        html: pageOptions.includeHtml ? html : undefined,
        rawHtml: pageOptions.includeRawHtml || extractorOptions.mode === "llm-extraction-from-raw-html" ? rawHtml : undefined,
        metadata: {
          ...metadata,
          sourceURL: urlToScrap,
          pageStatusCode: pageStatusCode,
          pageError: pageError,
        },
      };
    }

    return document;
  } catch (error) {
    console.error(`Error: ${error} - Failed to fetch URL: ${urlToScrap}`);
    return {
      content: "",
      markdown: "",
      html: "",
      metadata: {
        sourceURL: urlToScrap,
        pageStatusCode: pageStatusCode,
        pageError: pageError,
      },
    } as Document;
  }
}
