/**
 * OmShare - AJAX & Network Utility Module
 * Provides resilient HTTP communication, retry policies, timeout management,
 * and connectivity diagnostics for fallback signaling and network health.
 */

(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OmAjax = factory();
  }
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  /**
   * Performs an asynchronous HTTP request with timeout and retry capabilities.
   *
   * @param {string} url - Target URL
   * @param {Object} [options={}] - Request configuration options
   * @param {string} [options.method='GET'] - HTTP Method (GET, POST, PUT, DELETE)
   * @param {Object|string} [options.body] - Request body (objects are serialized to JSON)
   * @param {Object} [options.headers={}] - Custom headers
   * @param {number} [options.timeout=10000] - Request timeout in milliseconds
   * @param {number} [options.retries=2] - Number of retry attempts on network error
   * @param {number} [options.retryDelay=1000] - Base delay between retries in ms
   * @returns {Promise<any>} Parsed response data (JSON or text)
   */
  async function request(url, options = {}) {
    const {
      method = 'GET',
      body = null,
      headers = {},
      timeout = 10000,
      retries = 2,
      retryDelay = 1000
    } = options;

    let attempt = 0;
    let lastError = null;

    while (attempt <= retries) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const reqHeaders = {
        'Accept': 'application/json, text/plain, */*',
        ...headers
      };

      let reqBody = body;
      if (body && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof Blob)) {
        reqHeaders['Content-Type'] = 'application/json';
        reqBody = JSON.stringify(body);
      }

      try {
        const response = await fetch(url, {
          method,
          headers: reqHeaders,
          body: method !== 'GET' && method !== 'HEAD' ? reqBody : undefined,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        let data = null;
        if (method !== 'HEAD') {
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            try {
              data = await response.json();
            } catch (e) {
              data = null;
            }
          } else {
            data = await response.text();
          }
        }

        if (!response.ok) {
          const errorMsg = (data && data.error) || (data && data.message) || `HTTP error ${response.status}: ${response.statusText}`;
          const err = new Error(errorMsg);
          err.status = response.status;
          err.data = data;
          throw err;
        }

        return data;
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err;

        if (err.name === 'AbortError') {
          lastError = new Error(`Request to ${url} timed out after ${timeout}ms`);
        }

        attempt++;
        if (attempt <= retries) {
          const delay = retryDelay * Math.pow(1.5, attempt - 1);
          await new Promise(res => setTimeout(res, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * Convenience helpers
   */
  function get(url, options = {}) {
    return request(url, { ...options, method: 'GET' });
  }

  function post(url, body, options = {}) {
    return request(url, { ...options, method: 'POST', body });
  }

  function put(url, body, options = {}) {
    return request(url, { ...options, method: 'PUT', body });
  }

  function del(url, options = {}) {
    return request(url, { ...options, method: 'DELETE' });
  }

  /**
   * Tests general internet connectivity by pinging a lightweight endpoint
   * @param {number} [timeout=4000]
   * @returns {Promise<boolean>}
   */
  async function checkConnectivity(timeout = 4000) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return false;
    }
    try {
      // Ping cache-busted favicon or local/CDN endpoint
      const pingUrl = `/icon-192.svg?_t=${Date.now()}`;
      await request(pingUrl, { method: 'HEAD', timeout, retries: 0 });
      return true;
    } catch (e) {
      return typeof navigator !== 'undefined' ? navigator.onLine : false;
    }
  }

  /**
   * Measures latency to a target URL in milliseconds
   * @param {string} url
   * @param {number} [timeout=5000]
   * @returns {Promise<number>} Latency in ms, or -1 on failure
   */
  async function ping(url, timeout = 5000) {
    const start = Date.now();
    try {
      await request(url, { method: 'HEAD', timeout, retries: 0 });
      return Date.now() - start;
    } catch (e) {
      return -1;
    }
  }

  /**
   * Verifies if Google / Firestore endpoints are reachable (diagnoses CSP or network blocks)
   * @param {string} [projectId]
   * @returns {Promise<{reachable: boolean, message: string}>}
   */
  async function checkFirebaseHealth(projectId) {
    if (!projectId) {
      return { reachable: false, message: 'No Firebase Project ID configured' };
    }

    const testUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(testUrl, {
        method: 'GET',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      // Even if 403 / 401, reaching the server means network & CSP are healthy
      if (response.status < 500) {
        return { reachable: true, message: 'Firestore API reachable' };
      }
      return { reachable: false, message: `Firestore returned status ${response.status}` };
    } catch (error) {
      if (error.name === 'AbortError') {
        return { reachable: false, message: 'Firestore connection timed out' };
      }
      return { reachable: false, message: `Firestore connection blocked: ${error.message}` };
    }
  }

  return {
    request,
    get,
    post,
    put,
    delete: del,
    checkConnectivity,
    ping,
    checkFirebaseHealth
  };
});
