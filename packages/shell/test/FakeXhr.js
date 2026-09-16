.pragma library

/**
 * The fake `XMLHttpRequest` every Ghostd request test drives.
 *
 * Tests install it through one of Ghostd's `*RequestFactory` seams, drive the
 * exchange by hand, and read back what the service sent. Ten test files each
 * carried their own copy, which had drifted apart — one could not deliver a
 * string body, two forgot `status = 0` on abort, and the abort flag was
 * `aborted` in some and `abortCount` in others. Sharing one fake means every
 * suite tests against the same request contract.
 *
 * `make` appends to `bucket` so a test can assert on the requests in order.
 */
function make(bucket) {
    const xhr = {
        readyState: 0,
        status: 0,
        responseText: "",
        method: "",
        url: "",
        body: null,
        /** Set once by `abort`; `abortCount` counts repeats. */
        aborted: false,
        abortCount: 0,
        headers: ({}),
        onreadystatechange: null,
        open: function (method, url) {
            this.method = method;
            this.url = url;
            this.readyState = 1;
        },
        setRequestHeader: function (name, value) {
            this.headers[name] = value;
        },
        send: function (body) {
            this.body = body === undefined ? null : body;
        },
        abort: function () {
            this.aborted = true;
            this.abortCount += 1;
            this.readyState = 4;
            this.status = 0;
            this.notify();
        },
        /** Deliver a response: an object is serialized, a string is sent as-is. */
        complete: function (status, body) {
            this.status = status;
            this.responseText = typeof body === "string" ? body : JSON.stringify(body);
            this.readyState = 4;
            this.notify();
        },
        notify: function () {
            if (typeof this.onreadystatechange === "function") this.onreadystatechange();
        }
    };
    bucket.push(xhr);
    return xhr;
}
