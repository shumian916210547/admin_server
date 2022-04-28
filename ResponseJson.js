class ResponseJson {
  msg;
  code;
  data;
  constructor() { }

  setCode(code) {
    this.code = code;
    return this;
  }

  setMessage(msg) {
    this.msg = msg?.toString();
    return this;
  }

  setData(data) {
    this.data = data;
    return this;
  }
}

module.exports = ResponseJson;