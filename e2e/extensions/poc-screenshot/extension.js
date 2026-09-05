export default class PocScreenshot {
    enable() {
        global.context.unsafe_mode = true;
    }
    disable() {
        global.context.unsafe_mode = false;
    }
}
