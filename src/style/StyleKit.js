import { StyleSheet, StatusBar, Alert, Platform, Dimensions } from 'react-native';
import ModelManager from "../lib/sfjs/modelManager"
import Server from "../lib/sfjs/httpManager"
import Sync from '../lib/sfjs/syncManager'
import Storage from "../lib/sfjs/storageManager"
import Auth from "../lib/sfjs/authManager"
import KeysManager from '../lib/keysManager'
import ApplicationState from '../ApplicationState'
import CSSParser from "./CSSParser";
import ThemeDownloader from "@Style/ThemeDownloader"
import Icons from '@Style/Icons';

import redJSON from './red.json';
import blueJSON from './blue.json';

export default class StyleKit {

  static instance = null;

  static get() {
    if (this.instance == null) {
      this.instance = new StyleKit();
    }

    return this.instance;
  }

  constructor() {
    this.themeChangeObservers = [];

    this.createDefaultThemes();

    KeysManager.get().registerAccountRelatedStorageKeys(["activeTheme"]);

    ModelManager.get().addItemSyncObserver("themes", "SN|Theme", function(allItems, validItems, deletedItems, source){
      if(this.activeTheme && this.activeTheme.isSwapIn) {
        var matchingTheme = _.find(this.themes(), {uuid: this.activeTheme.uuid});
        if(matchingTheme) {
          this.setActiveTheme(matchingTheme);
          this.activeTheme.isSwapIn = false;
          this.activeTheme.setMobileActive(true);
        }
      }
    }.bind(this));
  }

  addThemeChangeObserver(observer) {
    this.themeChangeObservers.push(observer);
    return observer;
  }

  removeThemeChangeObserver(observer) {
    _.remove(this.themeChangeObservers, observer);
  }

  notifyObserversOfThemeChange() {
    for(var observer of this.themeChangeObservers) {
      observer();
    }
  }

  // When downloading an external theme, we can't depend on it having all the variables present.
  // So we will merge them with this template variable list to make sure the end result has all
  // variables the app expects.
  templateVariables() {
    return redJSON;
  }

  createDefaultThemes() {
    this.systemThemes = [];
    let options = [
      {
        variables: redJSON,
        name: "Red"
      },
      {
        variables: blueJSON,
        name: "Blue"
      }
    ];

    for(var option of options) {
      let variables = option.variables;

      let theme = new SNTheme({
        uuid: option.name,
        content: {
          isSystemTheme: true,
          name: option.name,
        }
      });

      theme.setMobileRules({
        name: option.name,
        rules: this.defaultRules(variables),
        variables: variables,
        statusBar: Platform.OS == "android" ? "light-content" : "dark-content"
      })

      this.systemThemes.push(theme);
    }
  }

  async resolveInitialTheme() {
    let runDefaultTheme = () => {
      var theme = this.systemThemes[0];
      theme.setMobileActive(true);
      this.setActiveTheme(theme);
    }

    // Get the active theme from storage rather than waiting for local database to load
    var themeResult = await Storage.get().getItem("activeTheme");
    if(!themeResult) {
      runDefaultTheme();
      return;
    }

    // JSON stringified content is generic and includes all items property at time of stringification
    // So we parse it, then set content to itself, so that the mapping can be handled correctly.
    try {
      var parsedTheme = JSON.parse(themeResult);
      var needsMigration = false;
      if(parsedTheme.mobileRules) {
        // Newer versions of the app persist a Theme object where mobileRules are nested in AppData.
        // We want to check if the currently saved data is of the old format, which uses theme.mobileRules
        // instead of theme.getMobileRules(). If so, we want to prepare it for the new format.
        needsMigration = true;
      }
      let content = Object.assign({}, parsedTheme);
      parsedTheme.content = content;

      var theme = new SNTheme(parsedTheme);
      if(needsMigration) {
        theme.setMobileRules(parsedTheme.mobileRules);
        theme.mobileRules = null;
      }

      theme.isSwapIn = true;
      this.setActiveTheme(theme);
    } catch (e) {
      console.error("Error parsing initial theme", e);
      runDefaultTheme();
    }
  }

  static variable(name) {
    return this.get().activeTheme.getMobileRules().variables[name];
  }

  static get variables() {
    return this.get().activeTheme.getMobileRules().variables;
  }

  static styles() {
    return this.get().activeTheme.getMobileRules();
  }

  static stylesForKey(key) {
    var rules = this.styles();
    var styles = [rules[key]];
    var platform = Platform.OS == "android" ? "Android" : "IOS";
    var platformRules = rules[key+platform];
    if(platformRules) {
      styles.push(platformRules);
    }
    return styles;
  }

  themes() {
    return this.systemThemes.concat(ModelManager.get().themes);
  }

  isThemeActive(theme) {
    if(this.activeTheme) {
      return theme.uuid == this.activeTheme.uuid;
    }
    return theme.isMobileActive();
  }

  setActiveTheme(theme) {
    // merge default variables in case these theme has variables that are missing
    let mobileRules = theme.getMobileRules();
    mobileRules.variables = _.merge(this.templateVariables(), mobileRules.variables);
    theme.setMobileRules(mobileRules);

    this.activeTheme = theme;

    Icons.get().loadIcons();

    this.notifyObserversOfThemeChange();
  }

  activateTheme(theme, writeToStorage = true) {
    if(this.activeTheme) {
      this.activeTheme.setMobileActive(false);
    }

    var performActivation = () => {
      this.setActiveTheme(theme);
      theme.setMobileActive(true);

      if(theme.content.isSystemTheme) {
        Storage.get().setItem("activeSystemTheme", theme.name);
        Storage.get().removeItem("activeTheme");
      } else if(writeToStorage) {
        Storage.get().setItem("activeTheme", JSON.stringify(theme));
      }

      // App.get().reload();
    }

    if(!theme.hasMobileRules()) {
      ThemeDownloader.get().downloadTheme(theme).then(() => {
        if(theme.getNotAvailOnMobile()) {
          Alert.alert("Not Available", "This theme is not available on mobile.");
        } else {
          Sync.get().sync();
          performActivation();
        }
      });
    } else {
      performActivation();
    }
  }

  async downloadThemeAndReload(theme) {
    await ThemeDownloader.get().downloadTheme(theme);
    await Sync.get().sync();
    this.activateTheme(theme);
  }

  static isIPhoneX() {
    // See https://mydevice.io/devices/ for device dimensions
    const X_WIDTH = 375;
    const X_HEIGHT = 812;
    const { height: D_HEIGHT, width: D_WIDTH } = Dimensions.get('window');
    return Platform.OS === 'ios' &&
      ((D_HEIGHT === X_HEIGHT && D_WIDTH === X_WIDTH) ||
        (D_HEIGHT === X_WIDTH && D_WIDTH === X_HEIGHT));
  }

  defaultRules(variables) {
    let mainTextFontSize = 16;
    let paddingLeft = 14;
    return {
      container: {
        height: "100%",
      },

      flexContainer: {
        flex: 1,
        flexDirection: 'column',
      },

      centeredContainer: {
        flex: 1,
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center'
      },

      flexedItem: {
        flexGrow: 1
      },

      uiText: {
        color: variables.stylekitForegroundColor,
        fontSize: mainTextFontSize,
      },

      view: {

      },

      contrastView: {

      },

      tableSection: {
        marginTop: 10,
        marginBottom: 10,
        backgroundColor: variables.stylekitBackgroundColor
      },

      sectionHeaderContainer: {
        flex: 1,
        flexGrow: 0,
        justifyContent: "space-between",
        flexDirection: 'row',
        paddingRight: paddingLeft,
        paddingBottom: 10,
        paddingTop: 10,
        backgroundColor: 'rgba(52, 52, 52, 0.0)'
      },

      sectionHeader: {
        backgroundColor: "transparent",
        fontSize: mainTextFontSize - 4,
        paddingLeft: paddingLeft,
        color: variables.stylekitNeutralColor,
        fontWeight: Platform.OS == "android" ? "bold" : "normal"
      },

      sectionHeaderButton: {
        color: variables.stylekitInfoColor
      },

      sectionHeaderAndroid: {
        fontSize: mainTextFontSize - 2,
        color: variables.stylekitInfoColor
      },

      sectionedTableCell: {
        borderBottomColor: variables.stylekitBorderColor,
        borderBottomWidth: 1,
        paddingLeft: paddingLeft,
        paddingRight: paddingLeft,
        paddingTop: 13,
        paddingBottom: 12,
        backgroundColor: variables.stylekitBackgroundColor,
        flex: 1,
      },

      textInputCell: {
        maxHeight: 50,
        paddingTop: 0,
        paddingBottom: 0
      },

      sectionedTableCellTextInput: {
        fontSize: mainTextFontSize,
        padding: 0,
        color: variables.stylekitForegroundColor,
        height: "100%"
      },

      sectionedTableCellFirst: {
        borderTopColor: variables.stylekitBorderColor,
        borderTopWidth: 1,
      },

      sectionedTableCellLast: {

      },

      sectionedAccessoryTableCell: {
        paddingTop: 0,
        paddingBottom: 0,
        minHeight: 47,
        backgroundColor: "transparent"
      },

      sectionedAccessoryTableCellLabel: {
        fontSize: mainTextFontSize,
        color: variables.stylekitForegroundColor,
        minWidth: "80%"
      },

      buttonCell: {
        paddingTop: 0,
        paddingBottom: 0,
        flex: 1,
        justifyContent: 'center'
      },

      buttonCellButton: {
        textAlign: "center",
        textAlignVertical: "center",
        color: Platform.OS == "android" ? variables.stylekitForegroundColor : variables.stylekitInfoColor,
        fontSize: mainTextFontSize,
      },

      buttonCellButtonLeft: {
        textAlign: "left",
      },

      noteText: {
        flexGrow: 1,
        marginTop: 0,
        paddingTop: 10,
        color: variables.stylekitForegroundColor,
        paddingLeft: paddingLeft,
        paddingRight: paddingLeft,
        paddingBottom: 10,
        backgroundColor: variables.stylekitBackgroundColor
      },

      noteTextIOS: {
        paddingLeft: paddingLeft - 5,
        paddingRight: paddingLeft - 5,
      },

      noteTextNoPadding: {
        paddingLeft: 0,
        paddingRight: 0
      },

      actionSheetWrapper: {

      },

      actionSheetOverlay: {
        // This is the dimmed background
        // backgroundColor: variables.stylekitNeutralColor
      },

      actionSheetBody: {
        // This will also set button border bottoms, since margin is used instead of borders
        backgroundColor: variables.stylekitBorderColor
      },

      actionSheetTitleWrapper: {
        backgroundColor: variables.stylekitBackgroundColor,
        marginBottom: 1
      },

      actionSheetTitleText: {
        color: variables.stylekitForegroundColor,
        opacity: 0.5
      },

      actionSheetButtonWrapper: {
        backgroundColor: variables.stylekitBackgroundColor,
        marginTop: 0
      },

      actionSheetButtonTitle: {
        color: variables.stylekitForegroundColor,
      },

      actionSheetCancelButtonWrapper: {
        marginTop: 0
      },

      actionSheetCancelButtonTitle: {
        color: variables.stylekitInfoColor,
        fontWeight: "normal"
      },

      bold: {
        fontWeight: "bold"
      },
    }
  }

  static actionSheetStyles() {
    return {
      wrapperStyle: StyleKit.styles().actionSheetWrapper,
      overlayStyle: StyleKit.styles().actionSheetOverlay,
      bodyStyle : StyleKit.styles().actionSheetBody,

      buttonWrapperStyle: StyleKit.styles().actionSheetButtonWrapper,
      buttonTitleStyle: StyleKit.styles().actionSheetButtonTitle,

      titleWrapperStyle: StyleKit.styles().actionSheetTitleWrapper,
      titleTextStyle: StyleKit.styles().actionSheetTitleText,
      tintColor: ApplicationState.isIOS ? undefined : StyleKit.variable("stylekitInfoColor"),

      buttonUnderlayColor: StyleKit.variable("stylekitBorderColor"),

      cancelButtonWrapperStyle: StyleKit.styles().actionSheetCancelButtonWrapper,
      cancelButtonTitleStyle: StyleKit.styles().actionSheetCancelButtonTitle,
      cancelMargin: StyleSheet.hairlineWidth
    }
  }

  static shadeBlend(p,c0,c1) {
    var n=p<0?p*-1:p,u=Math.round,w=parseInt;
    if(c0.length>7){
      var f=c0.split(","),t=(c1?c1:p<0?"rgb(0,0,0)":"rgb(255,255,255)").split(","),R=w(f[0].slice(4)),G=w(f[1]),B=w(f[2]);
      return "rgb("+(u((w(t[0].slice(4))-R)*n)+R)+","+(u((w(t[1])-G)*n)+G)+","+(u((w(t[2])-B)*n)+B)+")"
    } else{
      var f=w(c0.slice(1),16),t=w((c1?c1:p<0?"#000000":"#FFFFFF").slice(1),16),R1=f>>16,G1=f>>8&0x00FF,B1=f&0x0000FF;
      return "#"+(0x1000000+(u(((t>>16)-R1)*n)+R1)*0x10000+(u(((t>>8&0x00FF)-G1)*n)+G1)*0x100+(u(((t&0x0000FF)-B1)*n)+B1)).toString(16).slice(1)
    }
  }

  static darken(color, value = -0.15) {
    return this.shadeBlend(value, color);
  }

  static lighten(color, value = 0.25) {
    return this.shadeBlend(value, color);
  }

  static hexToRGBA(hex, alpha) {
    if(!hex) {
      return null;
    }
    var c;
    if(/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)) {
      c= hex.substring(1).split('');
      if(c.length== 3){
          c= [c[0], c[0], c[1], c[1], c[2], c[2]];
      }
      c= '0x'+c.join('');
      return 'rgba('+[(c>>16)&255, (c>>8)&255, c&255].join(',')+',' + alpha + ')';
    } else {
      throw new Error('Bad Hex');
    }
  }

}