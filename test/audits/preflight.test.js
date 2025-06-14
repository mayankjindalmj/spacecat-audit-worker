/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-env mocha */

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import nock from 'nock';
import AWSXray from 'aws-xray-sdk';
import { FirefallClient, GenvarClient } from '@adobe/spacecat-shared-gpt-client';
import { isValidUrls, preflightAudit, scrapePages } from '../../src/preflight/handler.js';
import { runInternalLinkChecks } from '../../src/preflight/internal-links.js';
import { MockContextBuilder } from '../shared.js';

use(sinonChai);
use(chaiAsPromised);
describe('Preflight Audit', () => {
  it('should validate pages sent for auditing', () => {
    const urls = [
      {
        url: 'https://main--cc--adobecom.aem.page/drafts/narcis/creativecloud',
      },
    ];

    const result = isValidUrls(urls);
    expect(result).to.be.true;
  });

  describe('runInternalLinkChecks with nock', () => {
    let context;

    beforeEach(() => {
      context = {
        log: {
          warn: sinon.stub(),
          info: sinon.stub(),
        },
      };
    });

    afterEach(() => {
      nock.cleanAll();
    });

    it('returns no broken links when all internal links are valid', async () => {
      nock('https://example.com')
        .head('/foo')
        .reply(200)
        .head('/bar')
        .reply(200);

      const scrapedObjects = [{
        data: {
          scrapeResult: { rawBody: '<a href="/foo">foo</a><a href="https://example.com/bar">bar</a>' },
          finalUrl: 'https://example.com/page1',
        },
      }];

      const result = await runInternalLinkChecks(scrapedObjects, 'token', context);
      expect(result.auditResult.brokenInternalLinks).to.deep.equal([]);
    });

    it('returns broken links for 404 responses', async () => {
      nock('https://example.com')
        .head('/broken')
        .reply(404);

      const scrapedObjects = [{
        data: {
          scrapeResult: { rawBody: '<a href="/broken">broken</a>' },
          finalUrl: 'https://example.com/page1',
        },
      }];

      const result = await runInternalLinkChecks(scrapedObjects, 'token', context);
      expect(result.auditResult.brokenInternalLinks).to.deep.equal([
        { pageUrl: 'https://example.com/page1', href: 'https://example.com/broken', status: 404 },
      ]);
    });

    it('handles fetch errors', async () => {
      nock('https://example.com')
        .head('/fail')
        .replyWithError('network fail');

      const scrapedObjects = [{
        data: {
          scrapeResult: { rawBody: '<a href="/fail">fail</a>' },
          finalUrl: 'https://example.com/page1',
        },
      }];

      const result = await runInternalLinkChecks(scrapedObjects, 'token', context);
      expect(result.auditResult.brokenInternalLinks).to.have.lengthOf(1);
      expect(result.auditResult.brokenInternalLinks[0]).to.include({
        pageUrl: 'https://example.com/page1',
        href: 'https://example.com/fail',
        status: null,
      });
      expect(result.auditResult.brokenInternalLinks[0].error).to.match(/network fail/);
    });
  });

  describe('isValidUrls', () => {
    it('returns true for a valid array of url objects', () => {
      const urls = [
        { url: 'https://example.com' },
        { url: 'https://another.com/page' },
      ];
      expect(isValidUrls(urls)).to.be.true;
    });

    it('returns false for an empty array', () => {
      expect(isValidUrls([])).to.be.false;
    });

    it('returns false if not all items have a valid url', () => {
      const urls = [
        { url: 'https://example.com' },
        { url: 'not-a-url' },
      ];
      expect(isValidUrls(urls)).to.be.false;
    });

    it('returns false if any item is missing the url property', () => {
      const urls = [
        { url: 'https://example.com' },
        { notUrl: 'https://another.com' },
      ];
      expect(isValidUrls(urls)).to.be.false;
    });

    it('returns false if input is not an array', () => {
      expect(isValidUrls(null)).to.be.false;
      expect(isValidUrls(undefined)).to.be.false;
      expect(isValidUrls('https://example.com')).to.be.false;
      expect(isValidUrls({ url: 'https://example.com' })).to.be.false;
    });

    it('returns false if array contains non-object items', () => {
      expect(isValidUrls(['https://example.com', 'https://another.com'])).to.be.false;
    });
  });

  describe('scrapePages', () => {
    it('returns the correct object for valid input', async () => {
      const context = {
        site: { getId: () => 'site-123' },
        job: {
          getMetadata: () => ({
            payload: {
              urls: [
                { url: 'https://example.com' },
                { url: 'https://another.com/page' },
              ],
            },
          }),
        },
      };
      const result = await scrapePages(context);
      expect(result).to.deep.equal({
        urls: [
          { url: 'https://example.com' },
          { url: 'https://another.com/page' },
        ],
        siteId: 'site-123',
        type: 'preflight',
        allowCache: false,
        options: {
          enableAuthentication: true,
        },
      });
    });

    it('throws an error if urls are invalid', async () => {
      const context = {
        site: { getId: () => 'site-123' },
        job: {
          getMetadata: () => ({
            payload: {
              urls: [
                { url: 'not-a-url' },
                { url: 'https://example.com' },
              ],
            },
          }),
        },
      };
      await expect(scrapePages(context)).to.be.rejectedWith('[preflight-audit] site: site-123. Invalid urls provided for scraping');
    });
  });

  describe('preflightAudit', () => {
    let context;
    let site;
    let job;
    let s3Client;
    let secretsClient;
    let configuration;
    let firefallClient;
    let genvarClient;

    const sandbox = sinon.createSandbox();

    beforeEach(() => {
      site = {
        getId: () => 'site-123',
        getBaseURL: () => 'https://example.com',
      };
      s3Client = {
        send: sinon.stub(),
      };
      secretsClient = {
        send: sinon.stub().resolves(
          {
            SecretString: JSON.stringify({ PAGE_AUTH_TOKEN: 'token' }),
          },
        ),
      };
      job = {
        getMetadata: () => ({
          payload: {
            urls: [{ url: 'https://example.com/page1' }],
          },
        }),
        getStatus: sinon.stub().returns('IN_PROGRESS'),
        getId: () => 'job-123',
        setStatus: sinon.stub(),
        setResultType: sinon.stub(),
        setResult: sinon.stub(),
        setEndedAt: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      firefallClient = {
        fetchChatCompletion: sandbox.stub(),
      };
      genvarClient = {
        generateSuggestions: sandbox.stub(),
      };
      sinon.stub(AWSXray, 'captureAWSv3Client').returns(secretsClient);
      sandbox.stub(FirefallClient, 'createFrom').returns(firefallClient);
      sandbox.stub(GenvarClient, 'createFrom').returns(genvarClient);
      context = new MockContextBuilder()
        .withSandbox(sinon.createSandbox())
        .withOverrides({
          job,
          site,
          s3Client,
          func: {
            version: 'test',
          },
        })
        .build();

      configuration = {
        isHandlerEnabledForSite: sinon.stub(),
      };
      context.dataAccess.Configuration.findLatest.resolves(configuration);
    });

    afterEach(() => {
      sinon.restore();
      sandbox.restore();
    });

    it('completes successfully on the happy path', async () => {
      s3Client.send.onCall(0).resolves({
        Contents: [
          { Key: 'scrapes/site-123/page1/scrape.json' },
        ],
      });
      const body = `<body>${'a'.repeat(70)}lorem ipsum<a href="broken"></a><a href="http://test.com"></a></body>`;
      s3Client.send.onCall(1).resolves({
        ContentType: 'application/json',
        Body: {
          transformToString: sinon.stub().resolves(JSON.stringify({
            scrapeResult: { rawBody: body },
            finalUrl: 'https://example.com/page1',
            tags: {
              title: 'Page 1 Title',
              description: 'Page 1 Description',
              h1: ['Page 1 H1'],
            },
          })),
        },
      });
      s3Client.send.onCall(2).resolves({
        Contents: [
          { Key: 'scrapes/site-123/page1/scrape.json' },
        ],
        IsTruncated: false,
        NextContinuationToken: 'token',
      });
      s3Client.send.onCall(4).resolves({
        ContentType: 'application/json',
        Body: {
          transformToString: sinon.stub().resolves(JSON.stringify({
            scrapeResult: {
              rawBody: '<a href="/foo">foo</a>',
              tags: {
                title: 'Page 1 Title',
                description: 'Page 1 Description',
                h1: ['Page 1 H1'],
              },
            },
            finalUrl: 'https://example.com/page1',
          })),
        },
      });
      configuration.isHandlerEnabledForSite.returns(true);
      genvarClient.generateSuggestions.resolves({
        '/page1': {
          h1: {
            aiRationale: 'The H1 tag is catchy and broad...',
            aiSuggestion: 'Our Story: Innovating Comfort for Every Home',
          },
          title: {
            aiRationale: 'The title is catchy and broad...',
            aiSuggestion: 'Our Story: Innovating Comfort for Every Home',
          },
        },
      });
      await preflightAudit(context);

      // stub retrievePageAuthentication
      expect(job.setStatus).to.have.been.calledWith('COMPLETED');
      expect(job.setResultType).to.have.been.called;
      expect(job.setResult).to.have.been.called;
      expect(job.setEndedAt).to.have.been.called;
      expect(job.save).to.have.been.called;
    });

    it('throws if job is not in progress', async () => {
      job.getStatus.returns('COMPLETED');
      await expect(preflightAudit(context)).to.be.rejectedWith('[preflight-audit] site: site-123. Job not in progress for jobId: job-123. Status: COMPLETED');
    });
  });
});
