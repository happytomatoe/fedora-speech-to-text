export default class PocScreenshot {
    enable() {
        this._prev = global.context.unsafe_mode;
        global.context.unsafe_mode = true;
    }
    disable() {
        global.context.unsafe_mode = this._prev;
    }
}
