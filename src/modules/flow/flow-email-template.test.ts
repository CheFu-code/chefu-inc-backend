import assert from "node:assert/strict";
import test from "node:test";
import {
    createFlowTemplateVariables,
    sanitizeFlowHtml,
} from "./flow-email-template";

void test("sanitizeFlowHtml removes executable markup and unsafe URLs", () => {
    const encodedJavascript = `java${String.fromCharCode(38)}#x73;cript:alert(1)`;
    const sanitized = sanitizeFlowHtml(
        `<svg/onload=alert(1)><script>alert(1)</script><iframe src="https://evil.example"></iframe><a href="${encodedJavascript}">unsafe</a><img src="data:text/html,alert(1)"><p><strong>safe</strong></p>`,
    );

    assert.doesNotMatch(sanitized, /svg|onload|script|iframe|javascript:|data:/i);
    assert.match(sanitized, /<p><strong>safe<\/strong><\/p>/);
});

void test("sanitizeFlowHtml preserves safe email links and images", () => {
    const sanitized = sanitizeFlowHtml(
        '<a href="https://example.com" target="_blank">Visit</a><img src="https://example.com/image.png" alt="Image">',
    );

    assert.match(sanitized, /href="https:\/\/example\.com"/);
    assert.match(sanitized, /src="https:\/\/example\.com\/image\.png"/);
});

void test("CTA variables omit unsafe URLs", () => {
    const unsafe = createFlowTemplateVariables({
        audienceName: "Audience",
        bodyHtml: "<p>Message</p>",
        ctaLabel: "Open",
        ctaUrl: "javascript:alert(1)",
        recipientName: "Recipient",
        senderName: "Sender",
        title: "Subject",
    });
    const safe = createFlowTemplateVariables({
        audienceName: "Audience",
        bodyHtml: "<p>Message</p>",
        ctaLabel: "Open",
        ctaUrl: "https://example.com/path",
        recipientName: "Recipient",
        senderName: "Sender",
        title: "Subject",
    });

    assert.equal(unsafe.variables.CTA_HTML, "");
    assert.match(safe.variables.CTA_HTML, /href="https:\/\/example\.com\/path"/);
});
