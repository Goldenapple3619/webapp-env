if (!document.__connectScript) {
document.__connectScript = (() => {
    function init() {
        var usernameInput;
        var passwordInput;
        var hostInput;
        var buttonSumbit;
        var errorBox;

        var connecting = false;

        function validateForm() {
            if (!hostInput || !usernameInput || !passwordInput || connecting)
                return;

            connecting = true;

            if (errorBox)
                errorBox.style.display = "none";

            if (!hostInput.value) {
                if (errorBox)
                    errorBox.innerText = "Host required.";
                    errorBox.style.display = "block";
                connecting = false;
                return;
            }

            document.app.getLibrary().request("http://" + hostInput.value + '/connect', JSON.stringify({"username": usernameInput.value, "password": passwordInput.value}), "POST", {"Content-Type": "application/json"}).then((data) => {
                connecting = false;

                try {
                    localStorage.setItem("host", hostInput.value);
                    localStorage.setItem("token", JSON.parse(data.request.responseText).token);
                    document.location.replace("http://" + hostInput.value + `/settoken?token=${localStorage.getItem("token")}&redirect=${document.location.protocol}//${document.location.host}/desktop/`);
                } catch {
                    if (!errorBox)
                        return;
                    errorBox.innerText = "Invalid server response.";
                    errorBox.style.display = "block";
                }
            }).catch((err) => {
                connecting = false;
                if (!errorBox)
                    return;
                if (!err.request) {
                    errorBox.innerText = "Network error.";
                    errorBox.style.display = "block";
                    return;
                }
                try {
                    errorBox.innerText = JSON.parse(err.request.responseText).message;
                } catch {
                    errorBox.innerText = "Invalid server response.";
                }
                errorBox.style.display = "block";
            });
        }

        function setForm(usernameDom, passwordDom, hostDom, buttonDom, errorDom) {
            usernameInput = usernameDom;
            passwordInput = passwordDom;
            hostInput = hostDom;
            buttonSumbit = buttonDom;
            errorBox = errorDom;

            if (hostInput && localStorage.getItem("host"))
                hostInput.value = localStorage.getItem("host");

            if (buttonSumbit)
                buttonSumbit.addEventListener("click", validateForm);
        }

        return ({
            setForm: setForm
        });
    }

    return ({
        new: function () {
            return (init());
        }
    });
})();
}
